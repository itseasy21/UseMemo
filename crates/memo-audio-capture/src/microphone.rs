//! Microphone capture backed by the platform audio framework.
//!
//! Two rules shape this module:
//!
//! 1. **The audio callback never blocks.** It converts to mono, then hands the
//!    block to a bounded channel with `try_send`. If the consumer stalls, the
//!    newest block is dropped and counted rather than stalling CoreAudio.
//! 2. **The stream never leaves its thread.** `cpal::Stream` is not `Send` on
//!    every backend, so the thread that builds the stream also owns it and drops
//!    it. Control crosses the boundary through an atomic stop flag.
//!
//! Audio is delivered as mono `f32` at the device's native rate. Resampling to
//! the 48 kHz meeting clock belongs to [`crate::source::CapturePipeline`] so the
//! same clock serves both microphone and system audio.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};

use crate::error::{AudioError, AudioResult};

/// How long [`MicrophoneCapture::start`] waits for the device to come up.
pub const START_TIMEOUT: Duration = Duration::from_secs(5);

/// Blocks buffered between the callback and the consumer (~2.7 s at 48 kHz).
pub const CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneInfo {
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
}

/// Names of every input device the host exposes, in platform order.
pub fn list_input_devices() -> AudioResult<Vec<String>> {
    let host = cpal::default_host();
    let devices = host.input_devices().map_err(|error| {
        AudioError::Unavailable(format!("cannot enumerate input devices: {error}"))
    })?;
    let mut names = Vec::new();
    for device in devices {
        if let Ok(name) = device.name() {
            names.push(name);
        }
    }
    Ok(names)
}

/// An open microphone stream.
///
/// Dropping the value stops capture and joins the stream thread, so the
/// microphone is released deterministically before the app tears down.
pub struct MicrophoneCapture {
    info: MicrophoneInfo,
    rx: Receiver<Vec<f32>>,
    stop: Arc<AtomicBool>,
    wake: Arc<(Mutex<()>, Condvar)>,
    last_error: Arc<Mutex<Option<String>>>,
    dropped: Arc<AtomicU64>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl MicrophoneCapture {
    /// Open the default input device, or the device whose name matches
    /// `device_hint` (exact, then case-insensitive).
    pub fn start(device_hint: Option<&str>) -> AudioResult<Self> {
        let (ready_tx, ready_rx) = sync_channel::<AudioResult<MicrophoneInfo>>(1);
        let (sample_tx, sample_rx) = sync_channel::<Vec<f32>>(CHANNEL_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let wake = Arc::new((Mutex::new(()), Condvar::new()));
        let last_error = Arc::new(Mutex::new(None));
        let dropped = Arc::new(AtomicU64::new(0));
        let hint = device_hint.map(str::to_owned);

        let thread_stop = Arc::clone(&stop);
        let thread_wake = Arc::clone(&wake);
        let thread_error = Arc::clone(&last_error);
        let thread_dropped = Arc::clone(&dropped);

        let thread = std::thread::Builder::new()
            .name("memo-microphone".into())
            .spawn(move || {
                let (stream, info) = match open_stream(
                    hint.as_deref(),
                    sample_tx,
                    Arc::clone(&thread_error),
                    Arc::clone(&thread_dropped),
                ) {
                    Ok(opened) => opened,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if let Err(error) = stream.play() {
                    let _ = ready_tx.send(Err(AudioError::Unavailable(format!(
                        "cannot start the microphone stream: {error}"
                    ))));
                    return;
                }
                let _ = ready_tx.send(Ok(info));

                // Park until the owner asks to stop. A timeout keeps the thread
                // responsive even if a notify is lost during shutdown.
                let (lock, cvar) = &*thread_wake;
                let mut guard = lock.lock().unwrap_or_else(|poison| poison.into_inner());
                while !thread_stop.load(Ordering::Acquire) {
                    let (next, _) = cvar
                        .wait_timeout(guard, Duration::from_millis(250))
                        .unwrap_or_else(|poison| poison.into_inner());
                    guard = next;
                }
                drop(guard);
                // Dropping the stream inside this thread is what releases the
                // device on every backend.
                drop(stream);
            })
            .map_err(|error| {
                AudioError::Unavailable(format!("cannot spawn capture thread: {error}"))
            })?;

        let info = match ready_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(info)) => info,
            Ok(Err(error)) => {
                let _ = thread.join();
                return Err(error);
            }
            Err(_) => {
                stop.store(true, Ordering::Release);
                wake.1.notify_all();
                let _ = thread.join();
                return Err(AudioError::Unavailable(
                    "timed out waiting for the microphone to start".into(),
                ));
            }
        };

        Ok(Self {
            info,
            rx: sample_rx,
            stop,
            wake,
            last_error,
            dropped,
            thread: Some(thread),
        })
    }

    pub fn info(&self) -> &MicrophoneInfo {
        &self.info
    }

    /// Wait up to `timeout` for the next mono block at the device rate.
    pub fn recv_timeout(&self, timeout: Duration) -> Option<Vec<f32>> {
        self.rx.recv_timeout(timeout).ok()
    }

    /// Take every block that is already buffered, up to `max_blocks`.
    pub fn drain(&self, max_blocks: usize) -> Vec<Vec<f32>> {
        let mut blocks = Vec::new();
        while blocks.len() < max_blocks {
            match self.rx.try_recv() {
                Ok(block) => blocks.push(block),
                Err(_) => break,
            }
        }
        blocks
    }

    /// Latest stream error reported by the platform, if any.
    pub fn last_error(&self) -> Option<String> {
        self.last_error
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// Blocks discarded because the consumer could not keep up.
    pub fn dropped_blocks(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Stop capture and release the device. Idempotent.
    pub fn stop(mut self) -> AudioResult<()> {
        self.shutdown()
    }

    fn shutdown(&mut self) -> AudioResult<()> {
        self.stop.store(true, Ordering::Release);
        self.wake.1.notify_all();
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| AudioError::Source("microphone thread panicked".into()))?;
        }
        Ok(())
    }
}

impl Drop for MicrophoneCapture {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn open_stream(
    device_hint: Option<&str>,
    tx: SyncSender<Vec<f32>>,
    last_error: Arc<Mutex<Option<String>>>,
    dropped: Arc<AtomicU64>,
) -> AudioResult<(cpal::Stream, MicrophoneInfo)> {
    let host = cpal::default_host();
    let device = select_device(&host, device_hint)?;
    let device_name = device
        .name()
        .unwrap_or_else(|_| "<unknown input>".to_string());

    if device
        .default_input_config()
        .map_err(|error| {
            AudioError::Unavailable(format!(
                "no usable input configuration on {device_name}: {error}"
            ))
        })?
        .channels()
        == 0
    {
        return Err(AudioError::Unavailable(format!(
            "{device_name} reports no input channels"
        )));
    }

    let supported = device.default_input_config().map_err(|error| {
        AudioError::Unavailable(format!(
            "no usable input configuration on {device_name}: {error}"
        ))
    })?;
    let sample_format = supported.sample_format();
    let channels = supported.channels();
    let sample_rate = supported.sample_rate().0;
    let config: cpal::StreamConfig = supported.into();

    let stream = match sample_format {
        SampleFormat::F32 => {
            build_stream::<f32>(&device, &config, channels, tx, last_error, dropped)
        }
        SampleFormat::I16 => {
            build_stream::<i16>(&device, &config, channels, tx, last_error, dropped)
        }
        SampleFormat::U16 => {
            build_stream::<u16>(&device, &config, channels, tx, last_error, dropped)
        }
        SampleFormat::I8 => build_stream::<i8>(&device, &config, channels, tx, last_error, dropped),
        SampleFormat::U8 => build_stream::<u8>(&device, &config, channels, tx, last_error, dropped),
        SampleFormat::I32 => {
            build_stream::<i32>(&device, &config, channels, tx, last_error, dropped)
        }
        SampleFormat::U32 => {
            build_stream::<u32>(&device, &config, channels, tx, last_error, dropped)
        }
        SampleFormat::F64 => {
            build_stream::<f64>(&device, &config, channels, tx, last_error, dropped)
        }
        other => {
            return Err(AudioError::Unavailable(format!(
                "unsupported microphone sample format {other:?}"
            )))
        }
    }
    .map_err(|error| AudioError::Unavailable(format!("cannot open {device_name}: {error}")))?;

    Ok((
        stream,
        MicrophoneInfo {
            device_name,
            sample_rate,
            channels,
            sample_format: format!("{sample_format:?}"),
        },
    ))
}

fn select_device(host: &cpal::Host, hint: Option<&str>) -> AudioResult<cpal::Device> {
    let Some(hint) = hint.map(str::trim).filter(|hint| !hint.is_empty()) else {
        return host.default_input_device().ok_or_else(|| {
            AudioError::Unavailable(
                "no default microphone; connect an input device or grant microphone access".into(),
            )
        });
    };

    let devices = host.input_devices().map_err(|error| {
        AudioError::Unavailable(format!("cannot enumerate input devices: {error}"))
    })?;
    let mut fallback = None;
    for device in devices {
        let Ok(name) = device.name() else { continue };
        if name == hint {
            return Ok(device);
        }
        if fallback.is_none() && name.to_lowercase().contains(&hint.to_lowercase()) {
            fallback = Some(device);
        }
    }
    fallback.ok_or_else(|| AudioError::Unavailable(format!("microphone {hint:?} was not found")))
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    tx: SyncSender<Vec<f32>>,
    last_error: Arc<Mutex<Option<String>>>,
    dropped: Arc<AtomicU64>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample + Sample,
    f32: FromSample<T>,
{
    let channel_count = channels.max(1) as usize;
    let mut scratch: Vec<f32> = Vec::new();
    let error_sink = Arc::clone(&last_error);
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            scratch.clear();
            scratch.extend(data.iter().map(|sample| sample.to_sample::<f32>()));
            let mono = downmix(&scratch, channel_count);
            match tx.try_send(mono) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                    dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        },
        move |error| {
            if let Ok(mut slot) = error_sink.lock() {
                *slot = Some(format!("microphone stream error: {error}"));
            }
        },
        None,
    )
}

/// Average interleaved frames into mono and clamp to the legal f32 range.
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    let channels = channels.max(1);
    if channels == 1 {
        return interleaved.iter().map(|sample| sanitize(*sample)).collect();
    }
    let frames = interleaved.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let start = frame * channels;
        let sum: f32 = interleaved[start..start + channels].iter().sum();
        mono.push(sanitize(sum / channels as f32));
    }
    mono
}

fn sanitize(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_frames_average_into_mono() {
        let stereo = [0.5, -0.5, 1.0, 0.0, -1.0, -1.0];
        assert_eq!(downmix(&stereo, 2), vec![0.0, 0.5, -1.0]);
    }

    #[test]
    fn trailing_partial_frame_is_ignored() {
        let stereo = [0.4, 0.4, 0.2];
        assert_eq!(downmix(&stereo, 2), vec![0.4]);
    }

    #[test]
    fn mono_passthrough_clamps_and_sanitizes() {
        let mono = [2.0, -3.0, f32::NAN, 0.25];
        assert_eq!(downmix(&mono, 1), vec![1.0, -1.0, 0.0, 0.25]);
    }

    #[test]
    fn zero_channel_count_is_treated_as_mono() {
        assert_eq!(downmix(&[0.1, 0.2], 0), vec![0.1, 0.2]);
    }

    #[test]
    fn info_serializes_as_camel_case() {
        let info = MicrophoneInfo {
            device_name: "MacBook Pro Microphone".into(),
            sample_rate: 48_000,
            channels: 1,
            sample_format: "F32".into(),
        };
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["deviceName"], "MacBook Pro Microphone");
        assert_eq!(value["sampleRate"], 48_000);
    }
}
