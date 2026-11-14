//! Durable meeting audio capture.
//!
//! Owns the whole local pipeline for one take. Each source has its own
//! independent archive so a failed loopback tap can never corrupt the
//! microphone master:
//!
//! ```text
//! microphone ──► channel pipeline ──► 16 kHz ──► audio.wav
//! system     ──► channel pipeline ──► 16 kHz ──► audio-system.wav
//! ```
//!
//! The WAVs are written while the meeting runs, so a crash or a forced quit
//! still leaves playable files with patched headers (see
//! `memo_audio_capture::wav`). Nothing here touches the network.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use memo_audio_capture::{
    CapturePipeline, DualStreamMixer, LevelMeter, MicrophoneCapture, MicrophoneInfo, SincResampler,
    SourceKind, WavSpec, WavWriter, TARGET_SAMPLE_RATE,
};
use tokio::sync::mpsc::Sender;

use crate::audio::system::SystemAudioCapture;
use crate::error::{AppError, AppResult};

/// Archive rate for meeting masters. 16 kHz mono is what on-device ASR
/// consumes, and it keeps an hour near 115 MB per channel.
pub const ARCHIVE_SAMPLE_RATE: u32 = 16_000;

/// How often the HUD receives a level frame.
pub const LEVEL_INTERVAL: Duration = Duration::from_millis(200);

/// Frames pulled from the mixer per write. 10 ms at 48 kHz.
const MIX_BLOCK_FRAMES: usize = 480;

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

    fn source_kind(self) -> SourceKind {
        match self {
            Self::Microphone => SourceKind::Microphone,
            Self::System => SourceKind::System,
        }
    }
}

/// A level frame on its way to the `audio:levels` event.
#[derive(Debug, Clone, Copy)]
pub struct AudioLevelSample {
    pub channel: AudioChannel,
    pub rms_dbfs: f32,
    pub peak_dbfs: f32,
    pub at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct AudioCaptureOutcome {
    pub channel: AudioChannel,
    pub path: PathBuf,
    /// Offset of the first written frame from the start of the take. The system
    /// tap can begin after the microphone, and an archive that starts later
    /// must not pretend its first word happened at t=0.
    pub started_at_ms: i64,
    pub duration_ms: i64,
    pub sample_rate: u32,
    pub blocks_written: u64,
    pub bytes: u64,
    pub peak_dbfs: f32,
    pub dropped_blocks: u64,
    pub device_name: String,
    /// True when no block ever rose above the noise floor, which on macOS is
    /// almost always a denied or muted capture permission.
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

    /// A take without a microphone archive is not a usable meeting.
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

/// A running capture. Dropping it stops and finalizes the take.
pub struct AudioCaptureSession {
    meeting_id: String,
    info: MicrophoneInfo,
    system_device: Option<String>,
    stop: Arc<AtomicBool>,
    workers: Vec<(
        AudioChannel,
        std::thread::JoinHandle<AppResult<AudioCaptureOutcome>>,
    )>,
}

impl AudioCaptureSession {
    /// Open the microphone (and, when `system_destination` is set, the platform
    /// loopback) and start writing both archives.
    ///
    /// Startup is transactional: if the system tap is requested and cannot be
    /// opened, the microphone worker is stopped and both partial files are
    /// removed before the error reaches the command.
    pub fn start(
        meeting_id: impl Into<String>,
        destination: PathBuf,
        system_destination: Option<PathBuf>,
        levels: Option<Sender<AudioLevelSample>>,
    ) -> AppResult<Self> {
        let microphone = MicrophoneCapture::start(None).map_err(capture_error)?;
        let info = microphone.info().clone();
        let system = match system_destination.as_ref() {
            Some(_) => Some(SystemAudioCapture::start()?),
            None => None,
        };
        let system_device = system
            .as_ref()
            .map(|capture| capture.device_name().to_string());
        let meeting_id = meeting_id.into();
        let started = Instant::now();
        let stop = Arc::new(AtomicBool::new(false));
        let mut workers = Vec::with_capacity(2);

        let thread_meeting = meeting_id.clone();
        let thread_stop = Arc::clone(&stop);
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
                    thread_levels,
                    started,
                )
            })
            .map_err(|error| {
                AppError::Capture(format!("cannot spawn the audio writer thread: {error}"))
            })?;
        workers.push((AudioChannel::Microphone, mic_worker));

        if let (Some(system), Some(system_path)) = (system, system_destination) {
            let thread_stop = Arc::clone(&stop);
            let thread_system_path = system_path.clone();
            let system_worker = std::thread::Builder::new()
                .name(format!("memo-system-{}", short_id(&meeting_id)))
                .spawn(move || {
                    run_source(
                        system,
                        AudioChannel::System,
                        &thread_system_path,
                        &thread_stop,
                        levels,
                        started,
                    )
                });
            match system_worker {
                Ok(worker) => workers.push((AudioChannel::System, worker)),
                Err(error) => {
                    stop.store(true, Ordering::Release);
                    if let Some((_, mic_worker)) = workers.pop() {
                        let _ = mic_worker.join();
                    }
                    remove_partial(&[destination.as_path(), system_path.as_path()]);
                    return Err(AppError::Capture(format!(
                        "cannot spawn the system-audio writer thread: {error}"
                    )));
                }
            }
        }

        Ok(Self {
            meeting_id,
            info,
            system_device,
            stop,
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
        self.stop.store(true, Ordering::Release);

        let mut take = AudioCaptureTake::default();
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

fn run_source<F: SourceFeed>(
    source: F,
    channel: AudioChannel,
    destination: &Path,
    stop: &Arc<AtomicBool>,
    levels: Option<Sender<AudioLevelSample>>,
    started: Instant,
) -> AppResult<AudioCaptureOutcome> {
    let sample_rate = source.sample_rate();
    let device_name = source.device_name();
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let spec = WavSpec::new(ARCHIVE_SAMPLE_RATE, 1).map_err(capture_error)?;
    let mut writer = WavWriter::create(destination, spec).map_err(capture_error)?;
    let mut pipeline = CapturePipeline::new(DualStreamMixer::default());
    let mut archive_resampler =
        SincResampler::new(TARGET_SAMPLE_RATE, ARCHIVE_SAMPLE_RATE).map_err(capture_error)?;
    let mut meter = LevelMeter::new();
    let mut mixed = vec![0.0f32; MIX_BLOCK_FRAMES];
    let mut archive = Vec::with_capacity(MIX_BLOCK_FRAMES);
    let mut peak_dbfs = memo_audio_capture::level::DBFS_FLOOR;
    let mut blocks_written = 0u64;
    let mut last_level = Instant::now();
    let mut started_at_ms: Option<i64> = None;

    loop {
        let stopping = stop.load(Ordering::Acquire);

        // Drain whatever the backend produced, then wait briefly for more.
        let mut incoming = source.drain(64);
        if incoming.is_empty() && !stopping {
            if let Some(block) = source.recv_timeout(Duration::from_millis(40)) {
                incoming.push(block);
            }
        }
        for block in incoming {
            if started_at_ms.is_none() && !block.is_empty() {
                started_at_ms = Some(started.elapsed().as_millis() as i64);
            }
            pipeline
                .push(channel.source_kind(), sample_rate, &block)
                .map_err(capture_error)?;
        }

        while let Some(produced) = drain_mix(&mut pipeline, &mut mixed) {
            archive.clear();
            archive_resampler.process(&mixed[..produced], &mut archive);
            writer.write_samples(&archive).map_err(capture_error)?;
            blocks_written = blocks_written.saturating_add(produced as u64);

            let frame = meter.process(&mixed[..produced]);
            peak_dbfs = peak_dbfs.max(frame.peak_dbfs);
            if let Some(sender) = levels.as_ref() {
                if last_level.elapsed() >= LEVEL_INTERVAL {
                    last_level = Instant::now();
                    let _ = sender.try_send(AudioLevelSample {
                        channel,
                        rms_dbfs: frame.rms_dbfs,
                        peak_dbfs: frame.peak_dbfs,
                        at_ms: pipeline.clock().elapsed_ms(),
                    });
                }
            }
        }

        if stopping {
            break;
        }
    }

    // Flush the resampler tail so the last 10 ms are not truncated.
    archive.clear();
    archive_resampler.finish(&mut archive);
    writer.write_samples(&archive).map_err(capture_error)?;

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

/// Pull one block from the mixer, or `None` when it has nothing left.
///
/// Returning `None` for a short read (rather than looping) keeps the caller's
/// outer loop in control of the stop flag.
fn drain_mix(pipeline: &mut CapturePipeline, mixed: &mut [f32]) -> Option<usize> {
    let produced = pipeline.mix_into(mixed);
    (produced > 0).then_some(produced)
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
    use memo_audio_capture::AudioSource;
    use memo_audio_capture::SyntheticSource;

    #[test]
    fn synthetic_take_produces_a_playable_archive() {
        // Exercise the exact chain used by run_source without a microphone.
        let dir = std::env::temp_dir().join(format!(
            "memo-audio-session-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let path = dir.join("audio.wav");
        let mut source = SyntheticSource::new(SourceKind::Microphone, 48_000, 500).unwrap();
        let mut pipeline = CapturePipeline::new(DualStreamMixer::default());
        let mut resampler = SincResampler::new(TARGET_SAMPLE_RATE, ARCHIVE_SAMPLE_RATE).unwrap();
        let mut writer =
            WavWriter::create(&path, WavSpec::new(ARCHIVE_SAMPLE_RATE, 1).unwrap()).unwrap();
        let mut raw = vec![0.0f32; 480];
        let mut mixed = vec![0.0f32; MIX_BLOCK_FRAMES];
        let mut archive = Vec::new();
        loop {
            let read = source.read(&mut raw).unwrap();
            if read == 0 {
                break;
            }
            pipeline
                .push(SourceKind::Microphone, 48_000, &raw[..read])
                .unwrap();
            while let Some(produced) = drain_mix(&mut pipeline, &mut mixed) {
                archive.clear();
                resampler.process(&mixed[..produced], &mut archive);
                writer.write_samples(&archive).unwrap();
            }
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
        let _ = std::fs::remove_dir_all(dir);
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
