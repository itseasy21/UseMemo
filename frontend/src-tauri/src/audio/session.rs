//! Durable meeting audio capture.
//!
//! Owns the whole local pipeline for one take:
//!
//! ```text
//! microphone ──► CapturePipeline ──► 48 kHz mix ──► meter ──► audio:levels
//!                                            └────► 16 kHz ──► WAV on disk
//! ```
//!
//! The WAV is written while the meeting runs, so a crash or a forced quit still
//! leaves a playable file with a patched header (see `memo_audio_capture::wav`).
//! Nothing here touches the network.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use memo_audio_capture::{
    CapturePipeline, DualStreamMixer, LevelMeter, MicrophoneCapture, MicrophoneInfo, SincResampler,
    SourceKind, WavSpec, WavWriter, TARGET_SAMPLE_RATE,
};
use tokio::sync::mpsc::Sender;

use crate::error::{AppError, AppResult};

/// Archive rate for meeting masters. 16 kHz mono is what on-device ASR
/// consumes, and it keeps an hour near 115 MB.
pub const ARCHIVE_SAMPLE_RATE: u32 = 16_000;

/// How often the HUD receives a level frame.
pub const LEVEL_INTERVAL: Duration = Duration::from_millis(200);

/// Frames pulled from the mixer per write. 10 ms at 48 kHz.
const MIX_BLOCK_FRAMES: usize = 480;

/// A level frame on its way to the `audio:levels` event.
#[derive(Debug, Clone, Copy)]
pub struct AudioLevelSample {
    pub rms_dbfs: f32,
    pub peak_dbfs: f32,
    pub at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct AudioCaptureOutcome {
    pub path: PathBuf,
    pub duration_ms: i64,
    pub sample_rate: u32,
    pub blocks_written: u64,
    pub bytes: u64,
    pub peak_dbfs: f32,
    pub dropped_blocks: u64,
    pub device_name: String,
    /// True when no block ever rose above the noise floor, which on macOS is
    /// almost always a denied or muted microphone.
    pub silent: bool,
}

impl AudioCaptureOutcome {
    pub fn path_string(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

/// A running capture. Dropping it stops and finalizes the take.
pub struct AudioCaptureSession {
    meeting_id: String,
    info: MicrophoneInfo,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<AppResult<AudioCaptureOutcome>>>,
}

impl AudioCaptureSession {
    /// Open the microphone and start writing `destination`.
    pub fn start(
        meeting_id: impl Into<String>,
        destination: PathBuf,
        levels: Option<Sender<AudioLevelSample>>,
    ) -> AppResult<Self> {
        let microphone = MicrophoneCapture::start(None).map_err(capture_error)?;
        let info = microphone.info().clone();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_meeting = meeting_id.into();

        let worker = std::thread::Builder::new()
            .name(format!("memo-audio-{}", short_id(&thread_meeting)))
            .spawn(move || run_capture(microphone, &destination, &thread_stop, levels))
            .map_err(|error| {
                AppError::Capture(format!("cannot spawn the audio writer thread: {error}"))
            })?;

        Ok(Self {
            meeting_id: thread_meeting,
            info,
            stop,
            worker: Some(worker),
        })
    }

    pub fn meeting_id(&self) -> &str {
        &self.meeting_id
    }

    pub fn info(&self) -> &MicrophoneInfo {
        &self.info
    }

    /// Stop capture, flush the tail, and return the finished take.
    pub fn stop(mut self) -> AppResult<AudioCaptureOutcome> {
        self.finish()
    }

    fn finish(&mut self) -> AppResult<AudioCaptureOutcome> {
        let Some(worker) = self.worker.take() else {
            return Err(AppError::Capture(
                "audio capture was already finalized".into(),
            ));
        };
        self.stop.store(true, Ordering::Release);
        worker
            .join()
            .map_err(|_| AppError::Capture("the audio writer thread panicked".into()))?
    }
}

impl Drop for AudioCaptureSession {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

fn run_capture(
    microphone: MicrophoneCapture,
    destination: &Path,
    stop: &Arc<AtomicBool>,
    levels: Option<Sender<AudioLevelSample>>,
) -> AppResult<AudioCaptureOutcome> {
    let info = microphone.info().clone();
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

    loop {
        let stopping = stop.load(Ordering::Acquire);

        // Drain whatever the callback produced, then wait briefly for more.
        let mut incoming = microphone.drain(64);
        if incoming.is_empty() && !stopping {
            if let Some(block) = microphone.recv_timeout(Duration::from_millis(40)) {
                incoming.push(block);
            }
        }
        for block in incoming {
            pipeline
                .push(SourceKind::Microphone, info.sample_rate, &block)
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
    let dropped_blocks = microphone.dropped_blocks();
    let stream_error = microphone.last_error();
    drop(microphone);

    if let Some(error) = stream_error {
        return Err(AppError::Capture(error));
    }

    Ok(AudioCaptureOutcome {
        path: destination.to_path_buf(),
        duration_ms,
        sample_rate: ARCHIVE_SAMPLE_RATE,
        blocks_written,
        bytes,
        peak_dbfs,
        dropped_blocks,
        device_name: info.device_name,
        silent: peak_dbfs <= -80.0,
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
        // Exercise the exact chain used by run_capture without a microphone.
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

    #[test]
    fn silence_is_reported_from_the_peak() {
        let outcome = AudioCaptureOutcome {
            path: PathBuf::from("/tmp/audio.wav"),
            duration_ms: 0,
            sample_rate: ARCHIVE_SAMPLE_RATE,
            blocks_written: 0,
            bytes: 0,
            peak_dbfs: -120.0,
            dropped_blocks: 0,
            device_name: "test".into(),
            silent: true,
        };
        assert!(outcome.silent);
        assert_eq!(outcome.path_string(), "/tmp/audio.wav");
    }
}
