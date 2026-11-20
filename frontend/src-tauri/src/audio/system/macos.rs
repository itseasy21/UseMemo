//! macOS system-audio capture through ScreenCaptureKit.
//!
//! ScreenCaptureKit is the Apple-supported path for capturing what the machine
//! plays. We ask for an audio-only stream (a tiny video surface, no screen
//! output handler), exclude this process so the app never records its own
//! playback, and hand mono 48 kHz float blocks to the session.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use screencapturekit::cm::{AudioBuffer, AudioBufferList};
use screencapturekit::prelude::*;

use crate::error::{AppError, AppResult};

const SAMPLE_RATE: u32 = 48_000;
const QUEUE_BLOCKS: usize = 96;
const SETUP_TIMEOUT: Duration = Duration::from_secs(20);

unsafe extern "C" {
    fn memo_macos_screen_capture_permission_status() -> i32;
    fn memo_macos_request_screen_capture_permission() -> i32;
}

pub fn permission_granted() -> bool {
    unsafe { memo_macos_screen_capture_permission_status() == 1 }
}

pub fn request_permission() -> bool {
    unsafe { memo_macos_request_screen_capture_permission() == 1 }
}

pub struct SystemAudioCapture {
    receiver: Receiver<Vec<f32>>,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl SystemAudioCapture {
    pub fn start() -> AppResult<Self> {
        let (audio_tx, audio_rx) = mpsc::sync_channel::<Vec<f32>>(QUEUE_BLOCKS);
        let (setup_tx, setup_rx) = mpsc::channel::<Result<(), String>>();
        let stop = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));
        let error = Arc::new(Mutex::new(None));

        let thread_stop = Arc::clone(&stop);
        let thread_dropped = Arc::clone(&dropped);
        let thread_error = Arc::clone(&error);
        let worker = std::thread::Builder::new()
            .name("memo-system-audio".into())
            .spawn(move || {
                run_stream(
                    audio_tx,
                    setup_tx,
                    thread_stop,
                    thread_dropped,
                    thread_error,
                );
            })
            .map_err(|cause| {
                AppError::Capture(format!("cannot start the system-audio thread: {cause}"))
            })?;

        match setup_rx.recv_timeout(SETUP_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                receiver: audio_rx,
                stop,
                dropped,
                error,
                worker: Some(worker),
            }),
            Ok(Err(message)) => {
                let _ = worker.join();
                Err(AppError::Capture(message))
            }
            Err(_) => {
                stop.store(true, Ordering::Release);
                // Do not join: first-run permission prompts can hold the setup
                // path open, and a recording command must not hang behind one.
                // The worker sees the stop flag and tears down if it ever
                // finishes starting.
                Err(AppError::Capture(
                    "system audio did not start in time. Grant Screen Recording permission in \
                     System Settings → Privacy & Security, then try again."
                        .into(),
                ))
            }
        }
    }

    pub fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }

    pub fn device_name(&self) -> &str {
        "System audio · ScreenCaptureKit"
    }

    pub fn drain(&self, max: usize) -> Vec<Vec<f32>> {
        let mut blocks = Vec::new();
        while blocks.len() < max {
            match self.receiver.try_recv() {
                Ok(block) => blocks.push(block),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        blocks
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Option<Vec<f32>> {
        self.receiver.recv_timeout(timeout).ok()
    }

    pub fn dropped_blocks(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn last_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|error| error.clone())
    }
}

impl Drop for SystemAudioCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run_stream(
    audio_tx: SyncSender<Vec<f32>>,
    setup_tx: mpsc::Sender<Result<(), String>>,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
) {
    let stream = match build_stream(audio_tx, Arc::clone(&dropped), Arc::clone(&error)) {
        Ok(stream) => stream,
        Err(message) => {
            let _ = setup_tx.send(Err(message));
            return;
        }
    };

    if let Err(cause) = stream.start_capture() {
        let _ = setup_tx.send(Err(permission_hint(&cause.to_string())));
        return;
    }
    let _ = setup_tx.send(Ok(()));

    // Keep the stream alive on this thread. ScreenCaptureKit invokes the
    // handler on its own dispatch queue, so this loop only owns lifecycle.
    while !stop.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = stream.stop_capture();
}

fn build_stream(
    audio_tx: SyncSender<Vec<f32>>,
    dropped: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
) -> Result<SCStream, String> {
    let content = SCShareableContent::get().map_err(|cause| permission_hint(&cause.to_string()))?;
    let display = content
        .displays()
        .into_iter()
        .next()
        .ok_or_else(|| "no display is available for system-audio capture".to_string())?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();

    let mut config = SCStreamConfiguration::default();
    // Audio-only: a tiny surface keeps ScreenCaptureKit from encoding frames
    // nobody consumes.
    config.set_width(2);
    config.set_height(2);
    config.set_captures_audio(true);
    config.set_sample_rate(SAMPLE_RATE as i32);
    config.set_channel_count(1);
    config.set_excludes_current_process_audio(true);
    config.set_shows_cursor(false);

    let mut stream = {
        let handler = ErrorHandler::new(move |cause: screencapturekit::error::SCError| {
            if let Ok(mut slot) = error.lock() {
                *slot = Some(cause.to_string());
            }
        });
        SCStream::new_with_delegate(&filter, &config, handler)
    };
    let handler = move |sample: screencapturekit::cm::CMSampleBuffer,
                        output_type: SCStreamOutputType| {
        if !matches!(output_type, SCStreamOutputType::Audio) {
            return;
        }
        let Some(list) = sample.audio_buffer_list() else {
            return;
        };
        let mono = mono_samples(&list);
        if mono.is_empty() {
            return;
        }
        if audio_tx.try_send(mono).is_err() {
            dropped.fetch_add(1, Ordering::Relaxed);
        }
    };
    if stream
        .add_output_handler(handler, SCStreamOutputType::Audio)
        .is_none()
    {
        return Err("ScreenCaptureKit refused the audio output handler".into());
    }
    Ok(stream)
}

fn permission_hint(raw: &str) -> String {
    format!(
        "system audio capture needs Screen Recording permission. Grant it in System Settings → \
         Privacy & Security → Screen Recording, then restart the app. ({raw})"
    )
}

/// Downmix a ScreenCaptureKit audio buffer to mono float samples.
///
/// The stream is requested as mono, but a device can still deliver stereo. Both
/// interleaved (one buffer, N channels) and planar (N buffers) layouts are
/// averaged, so a future configuration change cannot produce scrambled audio.
fn mono_samples(list: &AudioBufferList) -> Vec<f32> {
    let buffers: Vec<&AudioBuffer> = (0..list.num_buffers())
        .filter_map(|index| list.get(index))
        .collect();
    if buffers.is_empty() {
        return Vec::new();
    }

    if buffers.len() == 1 {
        let buffer = buffers[0];
        let channels = buffer.number_channels().max(1) as usize;
        return downmix_interleaved(buffer.data(), channels);
    }

    let planar: Vec<Vec<f32>> = buffers
        .iter()
        .map(|buffer| downmix_interleaved(buffer.data(), buffer.number_channels().max(1) as usize))
        .collect();
    let frames = planar.iter().map(Vec::len).min().unwrap_or(0);
    let mut out = Vec::with_capacity(frames);
    for frame in 0..frames {
        let sum: f32 = planar.iter().map(|channel| channel[frame]).sum();
        out.push(sum / planar.len() as f32);
    }
    out
}

fn downmix_interleaved(bytes: &[u8], channels: usize) -> Vec<f32> {
    let channels = channels.max(1);
    let frames = bytes.len() / (std::mem::size_of::<f32>() * channels);
    let mut out = Vec::with_capacity(frames);
    for frame in 0..frames {
        let mut sum = 0.0f32;
        for channel in 0..channels {
            let offset = (frame * channels + channel) * 4;
            sum += f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]);
        }
        out.push(sum / channels as f32);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleaved_stereo_is_averaged() {
        let mut bytes = Vec::new();
        for (left, right) in [(1.0f32, 0.0f32), (0.5, -0.5), (-1.0, -1.0)] {
            bytes.extend_from_slice(&left.to_le_bytes());
            bytes.extend_from_slice(&right.to_le_bytes());
        }
        let mono = downmix_interleaved(&bytes, 2);
        assert_eq!(mono, vec![0.5, 0.0, -1.0]);
    }

    #[test]
    fn partial_samples_are_ignored() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0.25f32.to_le_bytes());
        bytes.extend_from_slice(&[0, 0]);
        assert_eq!(downmix_interleaved(&bytes, 1), vec![0.25]);
    }
}
