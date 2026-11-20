//! Durable meeting audio capture with monotonic wall-clock silence padding,
//! single-stage direct resampling (`native -> 16 kHz`), cross-channel acoustic
//! echo-bleed gating, pause/resume support, and device selection.
//!
//! ```text
//! microphone ──► direct 16 kHz resampler + echo-bleed gate ──► audio.wav
//! system     ──► direct 16 kHz resampler + silence padder  ──► audio-system.wav
//! ```

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memo_audio_capture::{
    LevelMeter, MicrophoneCapture, MicrophoneInfo, SincResampler, WavSpec, WavWriter,
};
use tokio::sync::mpsc::Sender;

use crate::audio::system::SystemAudioCapture;
use crate::error::{AppError, AppResult};

/// Archive rate for meeting masters. 16 kHz mono is what on-device ASR
/// consumes, keeping an hour near 115 MB per channel.
pub const ARCHIVE_SAMPLE_RATE: u32 = 16_000;

/// How often the HUD receives a level frame.
pub const LEVEL_INTERVAL: Duration = Duration::from_millis(200);

/// When an OS loopback backend pauses callbacks during remote silence for more
/// than 120 ms (`1,920` samples @ 16 kHz), synthesize zero-padding silence
/// frames so `audio-system.wav` never drifts behind `audio.wav`.
const SILENCE_PAD_THRESHOLD_FRAMES: u64 = 1_920;

/// Gain applied to microphone frames when acoustic loudspeaker bleed from the
/// system channel is detected while the local user is silent.
const ECHO_BLEED_ATTENUATION: f32 = 0.12;

/// Which physical stream an archive or level frame belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioChannel {
    Microphone,
    System,
}

impl AudioChannel {
    /// Stable wire name shared with the transcript `audio_channel` column.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Microphone => "mic",
            Self::System => "system",
        }
    }
}

/// A level frame on its way to the `audio:levels` event.
#[derive(Debug, Clone)]
pub struct AudioLevelSample {
    pub channel: AudioChannel,
    pub rms_dbfs: f32,
    pub peak_dbfs: f32,
    pub at_ms: i64,
    pub echo_bleed: bool,
    pub device_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AudioCaptureOutcome {
    pub channel: AudioChannel,
    pub path: PathBuf,
    /// Offset of the first written frame from the start of the take.
    pub started_at_ms: i64,
    pub duration_ms: i64,
    pub sample_rate: u32,
    pub blocks_written: u64,
    pub bytes: u64,
    pub peak_dbfs: f32,
    pub dropped_blocks: u64,
    pub device_name: String,
    /// True when no block ever rose above the noise floor.
    pub silent: bool,
    /// A stream error that truncated the archive. The file is still playable.
    pub error: Option<String>,
}

impl AudioCaptureOutcome {
    pub fn path_string(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    /// End of this archive on the take's shared timeline.
    pub fn end_ms(&self) -> i64 {
        self.started_at_ms + self.duration_ms
    }
}

/// Both archives from one take.
#[derive(Debug, Clone, Default)]
pub struct AudioCaptureTake {
    pub microphone: Option<AudioCaptureOutcome>,
    pub system: Option<AudioCaptureOutcome>,
    /// Set when the system tap was requested but could not be finalized.
    pub system_error: Option<String>,
}

impl AudioCaptureTake {
    fn push(&mut self, outcome: AudioCaptureOutcome) {
        match outcome.channel {
            AudioChannel::Microphone => self.microphone = Some(outcome),
            AudioChannel::System => self.system = Some(outcome),
        }
    }

    pub fn duration_ms(&self) -> i64 {
        self.microphone
            .iter()
            .chain(self.system.iter())
            .map(AudioCaptureOutcome::end_ms)
            .max()
            .unwrap_or(0)
    }

    pub fn has_microphone(&self) -> bool {
        self.microphone.is_some()
    }

    pub fn errors(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if let Some(error) = self.microphone.as_ref().and_then(|out| out.error.clone()) {
            errors.push(format!("microphone: {error}"));
        }
        if let Some(error) = self.system.as_ref().and_then(|out| out.error.clone()) {
            errors.push(format!("system audio: {error}"));
        }
        if let Some(error) = &self.system_error {
            errors.push(format!("system audio: {error}"));
        }
        errors
    }
}

/// Shared monotonic session clock that subtracts user-paused intervals so
/// pausing a recording neither inflates duration nor injects silence padding.
struct ActiveClock {
    started: Instant,
    state: Mutex<(Option<Instant>, Duration)>,
}

impl ActiveClock {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            state: Mutex::new((None, Duration::ZERO)),
        }
    }

    fn set_paused(&self, paused: bool) -> bool {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match (paused, guard.0) {
            (true, None) => {
                guard.0 = Some(Instant::now());
                true
            }
            (false, Some(paused_since)) => {
                let extra = paused_since.elapsed();
                guard.1 = guard.1.saturating_add(extra);
                guard.0 = None;
                false
            }
            (_, current) => current.is_some(),
        }
    }

    fn elapsed_active_ms(&self) -> i64 {
        let guard = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let total_paused = match guard.0 {
            Some(since) => guard.1.saturating_add(since.elapsed()),
            None => guard.1,
        };
        self.started
            .elapsed()
            .saturating_sub(total_paused)
            .as_millis() as i64
    }
}

/// A running capture. Dropping it stops and finalizes the take.
pub struct AudioCaptureSession {
    meeting_id: String,
    info: MicrophoneInfo,
    system_device: Option<String>,
    system_start_error: Option<String>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    clock: Arc<ActiveClock>,
    workers: Vec<(
        AudioChannel,
        std::thread::JoinHandle<AppResult<AudioCaptureOutcome>>,
    )>,
}

impl AudioCaptureSession {
    pub fn start(
        meeting_id: impl Into<String>,
        destination: PathBuf,
        system_destination: Option<PathBuf>,
        levels: Option<Sender<AudioLevelSample>>,
    ) -> AppResult<Self> {
        Self::start_with_device(meeting_id, destination, system_destination, None, levels)
    }

    pub fn start_with_device(
        meeting_id: impl Into<String>,
        destination: PathBuf,
        system_destination: Option<PathBuf>,
        microphone_device: Option<&str>,
        levels: Option<Sender<AudioLevelSample>>,
    ) -> AppResult<Self> {
        let microphone = MicrophoneCapture::start(microphone_device).map_err(capture_error)?;
        let info = microphone.info().clone();
        let meeting_id = meeting_id.into();
        let clock = Arc::new(ActiveClock::new());
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let has_system_stream = Arc::new(AtomicBool::new(false));
        let system_rms_bits = Arc::new(AtomicU32::new((-120.0f32).to_bits()));
        let mut workers = Vec::with_capacity(2);

        let thread_meeting = meeting_id.clone();
        let thread_stop = Arc::clone(&stop);
        let thread_paused = Arc::clone(&paused);
        let thread_clock = Arc::clone(&clock);
        let thread_has_system = Arc::clone(&has_system_stream);
        let thread_sys_rms = Arc::clone(&system_rms_bits);
        let thread_levels = levels.clone();
        let mic_destination = destination.clone();
        let mic_worker = std::thread::Builder::new()
            .name(format!("memo-audio-{}", short_id(&thread_meeting)))
            .spawn(move || {
                run_source(
                    microphone,
                    AudioChannel::Microphone,
                    &mic_destination,
                    &thread_stop,
                    &thread_paused,
                    &thread_clock,
                    thread_has_system,
                    &thread_sys_rms,
                    thread_levels,
                )
            })
            .map_err(|error| {
                remove_partial(&[destination.as_path()]);
                AppError::Capture(format!("cannot spawn the audio writer thread: {error}"))
            })?;
        workers.push((AudioChannel::Microphone, mic_worker));

        // Start loopback only after the microphone writer is draining. macOS
        // may hold this call behind a first-run permission prompt; keeping the
        // writer live prevents the bounded microphone queue from dropping the
        // first seconds of the take while loopback resolves or times out.
        let (system, mut system_start_error) = match system_destination.as_ref() {
            Some(_) => match SystemAudioCapture::start() {
                Ok(capture) => (Some(capture), None),
                Err(error) => {
                    tracing::warn!(error = %error, "system audio unavailable; continuing microphone-only");
                    (None, Some(error.to_string()))
                }
            },
            None => (None, None),
        };
        let system_device = system
            .as_ref()
            .map(|capture| capture.device_name().to_string());

        if let (Some(system), Some(system_path)) = (system, system_destination) {
            has_system_stream.store(true, Ordering::Release);
            let thread_stop = Arc::clone(&stop);
            let thread_paused = Arc::clone(&paused);
            let thread_clock = Arc::clone(&clock);
            let thread_has_system = Arc::clone(&has_system_stream);
            let thread_sys_rms = Arc::clone(&system_rms_bits);
            let thread_system_path = system_path.clone();
            let system_worker = std::thread::Builder::new()
                .name(format!("memo-system-{}", short_id(&meeting_id)))
                .spawn(move || {
                    run_source(
                        system,
                        AudioChannel::System,
                        &thread_system_path,
                        &thread_stop,
                        &thread_paused,
                        &thread_clock,
                        thread_has_system,
                        &thread_sys_rms,
                        levels,
                    )
                });
            match system_worker {
                Ok(worker) => workers.push((AudioChannel::System, worker)),
                Err(error) => {
                    let message = format!("cannot spawn the system-audio writer thread: {error}");
                    tracing::warn!(error = %message, "system audio unavailable; continuing microphone-only");
                    system_start_error = Some(message);
                    has_system_stream.store(false, Ordering::Release);
                    remove_partial(&[system_path.as_path()]);
                }
            }
        }

        Ok(Self {
            meeting_id,
            info,
            system_device,
            system_start_error,
            stop,
            paused,
            clock,
            workers,
        })
    }

    pub fn meeting_id(&self) -> &str {
        &self.meeting_id
    }

    pub fn info(&self) -> &MicrophoneInfo {
        &self.info
    }

    pub fn system_device(&self) -> Option<&str> {
        self.system_device.as_deref()
    }

    pub fn system_start_error(&self) -> Option<&str> {
        self.system_start_error.as_deref()
    }

    pub fn pause(&self) {
        self.clock.set_paused(true);
        self.paused.store(true, Ordering::Release);
    }

    pub fn resume(&self) {
        self.clock.set_paused(false);
        self.paused.store(false, Ordering::Release);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    pub fn active_elapsed_ms(&self) -> i64 {
        self.clock.elapsed_active_ms()
    }

    /// Stop capture, flush both tails, and return the finished archives.
    pub fn stop(mut self) -> AppResult<AudioCaptureTake> {
        self.finish()
    }

    fn finish(&mut self) -> AppResult<AudioCaptureTake> {
        if self.workers.is_empty() {
            return Err(AppError::Capture(
                "audio capture was already finalized".into(),
            ));
        }
        self.paused.store(false, Ordering::Release);
        self.clock.set_paused(false);
        self.stop.store(true, Ordering::Release);

        let mut take = AudioCaptureTake {
            system_error: self.system_start_error.clone(),
            ..AudioCaptureTake::default()
        };
        for (channel, worker) in self.workers.drain(..) {
            match worker.join() {
                Ok(Ok(outcome)) => take.push(outcome),
                Ok(Err(error)) => match channel {
                    AudioChannel::System => take.system_error = Some(error.to_string()),
                    AudioChannel::Microphone => {
                        return Err(AppError::Capture(format!("microphone: {error}")))
                    }
                },
                Err(_) => {
                    let message = "the audio writer thread panicked".to_string();
                    match channel {
                        AudioChannel::System => take.system_error = Some(message),
                        AudioChannel::Microphone => return Err(AppError::Capture(message)),
                    }
                }
            }
        }
        Ok(take)
    }
}

impl Drop for AudioCaptureSession {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

/// Minimal view over a capture backend so the writer loop is written once.
trait SourceFeed: Send + 'static {
    fn sample_rate(&self) -> u32;
    fn drain(&self, max: usize) -> Vec<Vec<f32>>;
    fn recv_timeout(&self, timeout: Duration) -> Option<Vec<f32>>;
    fn dropped_blocks(&self) -> u64;
    fn last_error(&self) -> Option<String>;
    fn device_name(&self) -> String;
}

impl SourceFeed for MicrophoneCapture {
    fn sample_rate(&self) -> u32 {
        self.info().sample_rate
    }

    fn drain(&self, max: usize) -> Vec<Vec<f32>> {
        MicrophoneCapture::drain(self, max)
    }

    fn recv_timeout(&self, timeout: Duration) -> Option<Vec<f32>> {
        MicrophoneCapture::recv_timeout(self, timeout)
    }

    fn dropped_blocks(&self) -> u64 {
        MicrophoneCapture::dropped_blocks(self)
    }

    fn last_error(&self) -> Option<String> {
        MicrophoneCapture::last_error(self)
    }

    fn device_name(&self) -> String {
        self.info().device_name.clone()
    }
}

impl SourceFeed for SystemAudioCapture {
    fn sample_rate(&self) -> u32 {
        SystemAudioCapture::sample_rate(self)
    }

    fn drain(&self, max: usize) -> Vec<Vec<f32>> {
        SystemAudioCapture::drain(self, max)
    }

    fn recv_timeout(&self, timeout: Duration) -> Option<Vec<f32>> {
        SystemAudioCapture::recv_timeout(self, timeout)
    }

    fn dropped_blocks(&self) -> u64 {
        SystemAudioCapture::dropped_blocks(self)
    }

    fn last_error(&self) -> Option<String> {
        SystemAudioCapture::last_error(self)
    }

    fn device_name(&self) -> String {
        SystemAudioCapture::device_name(self).to_string()
    }
}

/// Check whether `mic_rms` represents acoustic loudspeaker bleed from `sys_rms`
/// rather than active local speech.
pub fn is_echo_bleed(mic_rms_dbfs: f32, sys_rms_dbfs: f32) -> bool {
    sys_rms_dbfs > -32.0
        && mic_rms_dbfs > -58.0
        && mic_rms_dbfs < -26.0
        && mic_rms_dbfs < sys_rms_dbfs - 12.0
}

fn pad_silence_to_clock<W: std::io::Write + std::io::Seek>(
    writer: &mut WavWriter<W>,
    archived_frames_16k: &mut u64,
    anchor_ms: i64,
    now_active_ms: i64,
) -> AppResult<()> {
    let elapsed_ms = (now_active_ms - anchor_ms).max(0) as u64;
    let expected_frames = (elapsed_ms * u64::from(ARCHIVE_SAMPLE_RATE)) / 1_000;
    if expected_frames <= archived_frames_16k.saturating_add(SILENCE_PAD_THRESHOLD_FRAMES) {
        return Ok(());
    }

    let mut missing = expected_frames - *archived_frames_16k;
    let zero_chunk = [0.0f32; 4_096];
    while missing > 0 {
        let n = (missing as usize).min(zero_chunk.len());
        writer
            .write_samples(&zero_chunk[..n])
            .map_err(capture_error)?;
        *archived_frames_16k += n as u64;
        missing -= n as u64;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn run_source<F: SourceFeed>(
    source: F,
    channel: AudioChannel,
    destination: &Path,
    stop: &Arc<AtomicBool>,
    paused: &Arc<AtomicBool>,
    clock: &Arc<ActiveClock>,
    has_system_stream: Arc<AtomicBool>,
    system_rms_bits: &Arc<AtomicU32>,
    levels: Option<Sender<AudioLevelSample>>,
) -> AppResult<AudioCaptureOutcome> {
    let sample_rate = source.sample_rate().max(8_000);
    let device_name = source.device_name();
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let spec = WavSpec::new(ARCHIVE_SAMPLE_RATE, 1).map_err(capture_error)?;
    let mut writer = WavWriter::create(destination, spec).map_err(capture_error)?;
    let mut direct_resampler = if sample_rate != ARCHIVE_SAMPLE_RATE {
        Some(SincResampler::new(sample_rate, ARCHIVE_SAMPLE_RATE).map_err(capture_error)?)
    } else {
        None
    };

    let mut meter = LevelMeter::new();
    let mut archive = Vec::with_capacity(1_024);
    let mut peak_dbfs = memo_audio_capture::level::DBFS_FLOOR;
    let mut blocks_written = 0u64;
    let mut archived_frames_16k = 0u64;
    let mut last_level = Instant::now();
    let mut last_signal_at = Instant::now();
    let mut reported_device_error = false;
    let mut started_at_ms: Option<i64> = (channel == AudioChannel::Microphone).then_some(0);

    loop {
        let stopping = stop.load(Ordering::Acquire);
        let is_paused = paused.load(Ordering::Acquire);

        let mut incoming = source.drain(64);
        if incoming.is_empty() && !stopping {
            if let Some(block) = source.recv_timeout(Duration::from_millis(40)) {
                incoming.push(block);
            }
        }

        if is_paused && !stopping {
            if channel == AudioChannel::System {
                system_rms_bits.store((-120.0f32).to_bits(), Ordering::Relaxed);
            }
            continue;
        }

        let now_active_ms = clock.elapsed_active_ms();

        // Decay shared system RMS if no loopback audio arrived recently so the
        // mic echo gate never stays latched after remote speech stops.
        if channel == AudioChannel::System
            && incoming.is_empty()
            && last_signal_at.elapsed() >= Duration::from_millis(250)
        {
            system_rms_bits.store((-120.0f32).to_bits(), Ordering::Relaxed);
        }

        for block in incoming {
            if block.is_empty() {
                continue;
            }
            last_signal_at = Instant::now();

            let anchor = *started_at_ms.get_or_insert(now_active_ms);
            let block_duration_ms = ((block.len() as u64 * 1_000) / u64::from(sample_rate)) as i64;
            let pre_block_ms = (now_active_ms - block_duration_ms).max(anchor);
            pad_silence_to_clock(&mut writer, &mut archived_frames_16k, anchor, pre_block_ms)?;

            archive.clear();
            if let Some(resampler) = direct_resampler.as_mut() {
                resampler.process(&block, &mut archive);
            } else {
                archive.extend(block.iter().map(|&s| {
                    if s.is_finite() {
                        s.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    }
                }));
            }

            let frame = meter.process(&archive);
            peak_dbfs = peak_dbfs.max(frame.peak_dbfs);

            let mut echo_bleed = false;
            if channel == AudioChannel::System {
                system_rms_bits.store(frame.rms_dbfs.to_bits(), Ordering::Relaxed);
            } else if has_system_stream.load(Ordering::Acquire) {
                let sys_rms = f32::from_bits(system_rms_bits.load(Ordering::Relaxed));
                if is_echo_bleed(frame.rms_dbfs, sys_rms) {
                    echo_bleed = true;
                    for sample in &mut archive {
                        *sample *= ECHO_BLEED_ATTENUATION;
                    }
                }
            }

            writer.write_samples(&archive).map_err(capture_error)?;
            archived_frames_16k = archived_frames_16k.saturating_add(archive.len() as u64);
            blocks_written = blocks_written.saturating_add(archive.len() as u64);

            if let Some(sender) = levels.as_ref() {
                if last_level.elapsed() >= LEVEL_INTERVAL {
                    last_level = Instant::now();
                    let dev_err = if !reported_device_error {
                        let e = source.last_error();
                        if e.is_some() {
                            reported_device_error = true;
                        }
                        e
                    } else {
                        None
                    };
                    let _ = sender.try_send(AudioLevelSample {
                        channel,
                        rms_dbfs: frame.rms_dbfs,
                        peak_dbfs: frame.peak_dbfs,
                        at_ms: now_active_ms,
                        echo_bleed,
                        device_error: dev_err,
                    });
                }
            }
        }

        // Surface mid-meeting device errors even when the stream stopped delivering samples.
        if !reported_device_error {
            if let Some(err) = source.last_error() {
                reported_device_error = true;
                if let Some(sender) = levels.as_ref() {
                    let _ = sender.try_send(AudioLevelSample {
                        channel,
                        rms_dbfs: -120.0,
                        peak_dbfs: -120.0,
                        at_ms: now_active_ms,
                        echo_bleed: false,
                        device_error: Some(err),
                    });
                }
            }
        }

        if stopping {
            break;
        }
    }

    if let Some(resampler) = direct_resampler.as_mut() {
        archive.clear();
        resampler.finish(&mut archive);
        if !archive.is_empty() {
            writer.write_samples(&archive).map_err(capture_error)?;
            archived_frames_16k = archived_frames_16k.saturating_add(archive.len() as u64);
        }
    }

    if let Some(anchor) = started_at_ms {
        let final_active_ms = clock.elapsed_active_ms();
        pad_silence_to_clock(
            &mut writer,
            &mut archived_frames_16k,
            anchor,
            final_active_ms,
        )?;
    }

    let duration_ms = writer.duration_ms();
    let bytes = writer.data_bytes();
    writer.finalize().map_err(capture_error)?;
    let dropped_blocks = source.dropped_blocks();
    let stream_error = source.last_error();
    drop(source);

    Ok(AudioCaptureOutcome {
        channel,
        path: destination.to_path_buf(),
        started_at_ms: started_at_ms.unwrap_or(0),
        duration_ms,
        sample_rate: ARCHIVE_SAMPLE_RATE,
        blocks_written,
        bytes,
        peak_dbfs,
        dropped_blocks,
        device_name,
        silent: peak_dbfs <= -80.0,
        error: stream_error,
    })
}

fn capture_error(error: memo_audio_capture::AudioError) -> AppError {
    AppError::Capture(error.to_string())
}

fn remove_partial(paths: &[&Path]) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
}

fn short_id(meeting_id: &str) -> String {
    meeting_id.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use memo_audio_capture::{AudioSource, SourceKind, SyntheticSource};

    #[test]
    fn synthetic_take_produces_a_playable_archive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let mut source = SyntheticSource::new(SourceKind::Microphone, 48_000, 500).unwrap();
        let mut resampler = SincResampler::new(48_000, ARCHIVE_SAMPLE_RATE).unwrap();
        let mut writer =
            WavWriter::create(&path, WavSpec::new(ARCHIVE_SAMPLE_RATE, 1).unwrap()).unwrap();
        let mut raw = vec![0.0f32; 480];
        let mut archive = Vec::new();
        loop {
            let read = source.read(&mut raw).unwrap();
            if read == 0 {
                break;
            }
            archive.clear();
            resampler.process(&raw[..read], &mut archive);
            writer.write_samples(&archive).unwrap();
        }
        archive.clear();
        resampler.finish(&mut archive);
        writer.write_samples(&archive).unwrap();
        let duration = writer.duration_ms();
        writer.finalize().unwrap();
        drop(writer);

        assert!((480..=520).contains(&duration), "duration_ms={duration}");
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert!(bytes.len() > 44);
        let declared = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        assert_eq!(declared, bytes.len() - 44);
    }

    #[test]
    fn sparse_loopback_bursts_are_padded_to_wall_clock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("system.wav");
        let mut writer =
            WavWriter::create(&path, WavSpec::new(ARCHIVE_SAMPLE_RATE, 1).unwrap()).unwrap();
        let mut archived_frames = 0u64;

        // 100ms speech burst at t=0..100ms
        let burst = vec![0.25f32; 1_600];
        writer.write_samples(&burst).unwrap();
        archived_frames += burst.len() as u64;

        // Remote participants stay silent from t=100ms..600ms (500ms silent gap),
        // then speak another 100ms burst at t=600ms..700ms.
        pad_silence_to_clock(&mut writer, &mut archived_frames, 0, 600).unwrap();
        writer.write_samples(&burst).unwrap();
        archived_frames += burst.len() as u64;
        writer.finalize().unwrap();

        assert_eq!(archived_frames, 11_200); // 700ms @ 16 kHz
        let decoded = memo_audio_capture::wav::read_wav(&path).unwrap();
        assert_eq!(decoded.samples.len(), 11_200);
        // Middle of gap (t=350ms -> sample 5,600) is zero-padded silence
        assert_eq!(decoded.samples[5_600], 0.0);
        // Second burst at t=600ms (sample 9,600) lands on exact timeline offset!
        assert!(decoded.samples[9_650] > 0.2);
    }

    #[test]
    fn echo_bleed_gate_distinguishes_loudspeaker_leakage_from_local_speech() {
        // Loud remote speaker (-18 dBFS) + faint mic bleed (-36 dBFS) -> gated
        assert!(is_echo_bleed(-36.0, -18.0));
        // Loud remote speaker (-18 dBFS) + active local user speaking over (-20 dBFS) -> NOT gated
        assert!(!is_echo_bleed(-20.0, -18.0));
        // Quiet remote channel (-50 dBFS) + quiet local user (-34 dBFS) -> NOT gated
        assert!(!is_echo_bleed(-34.0, -50.0));
    }

    fn outcome(channel: AudioChannel, started_at_ms: i64, duration_ms: i64) -> AudioCaptureOutcome {
        AudioCaptureOutcome {
            channel,
            path: PathBuf::from("/tmp/audio.wav"),
            started_at_ms,
            duration_ms,
            sample_rate: ARCHIVE_SAMPLE_RATE,
            blocks_written: 0,
            bytes: 0,
            peak_dbfs: -120.0,
            dropped_blocks: 0,
            device_name: "test".into(),
            silent: true,
            error: None,
        }
    }

    #[test]
    fn silence_is_reported_from_the_peak() {
        let outcome = outcome(AudioChannel::Microphone, 0, 0);
        assert!(outcome.silent);
        assert_eq!(outcome.path_string(), "/tmp/audio.wav");
    }

    #[test]
    fn take_duration_covers_a_late_system_archive() {
        let mut take = AudioCaptureTake::default();
        take.push(outcome(AudioChannel::Microphone, 0, 60_000));
        take.push(outcome(AudioChannel::System, 250, 3_000));
        assert_eq!(take.duration_ms(), 60_000);

        take.push(outcome(AudioChannel::System, 250, 59_900));
        assert_eq!(take.duration_ms(), 60_150);
        assert!(take.has_microphone());
    }

    #[test]
    fn system_failure_is_a_fact_not_a_lost_microphone_take() {
        let mut take = AudioCaptureTake::default();
        take.push(outcome(AudioChannel::Microphone, 0, 10_000));
        take.system_error = Some("permission revoked".into());
        assert!(take.has_microphone());
        assert_eq!(take.errors(), vec!["system audio: permission revoked"]);
    }
}
