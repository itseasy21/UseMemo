//! Windows system-audio capture through WASAPI loopback.
//!
//! Loopback is a capture stream opened on the default *render* endpoint. We ask
//! WASAPI to convert to 32-bit float at 48 kHz, downmix to mono, and hand
//! 10 ms blocks to the session.
//!
//! This backend is compiled only on Windows. It has not been exercised on a
//! Windows host in this repository's recorded environment; the macOS path has.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use crate::error::{AppError, AppResult};

const SAMPLE_RATE: u32 = 48_000;
const QUEUE_BLOCKS: usize = 96;
const BLOCK_FRAMES: usize = 480;
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

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
                run_loopback(
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
                // A driver that stalls in setup must not hang the recording
                // command. Detach; the worker stops as soon as it observes the
                // flag.
                Err(AppError::Capture(
                    "WASAPI loopback did not start in time".into(),
                ))
            }
        }
    }

    pub fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }

    pub fn device_name(&self) -> &str {
        "System audio · WASAPI loopback"
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

fn run_loopback(
    audio_tx: SyncSender<Vec<f32>>,
    setup_tx: mpsc::Sender<Result<(), String>>,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
) {
    match start_client() {
        Ok(client) => {
            let _ = setup_tx.send(Ok(()));
            let mut deque: VecDeque<u8> = VecDeque::with_capacity(BLOCK_FRAMES * 8 * 4);
            while !stop.load(Ordering::Acquire) {
                if let Err(cause) = client.capture.read_from_device_to_deque(&mut deque) {
                    record_error(&error, format!("WASAPI read failed: {cause}"));
                    break;
                }
                while deque.len() >= BLOCK_FRAMES * 2 * 4 {
                    let mut chunk = vec![0.0f32; BLOCK_FRAMES];
                    for sample in chunk.iter_mut() {
                        let left = take_f32(&mut deque);
                        let right = take_f32(&mut deque);
                        *sample = (left + right) * 0.5;
                    }
                    if audio_tx.try_send(chunk).is_err() {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                // Timeouts are normal when nothing is playing; they only pace
                // the stop check.
                let _ = client.event.wait_for_event(200);
            }
            let _ = client.client.stop_stream();
        }
        Err(message) => {
            let _ = setup_tx.send(Err(message));
        }
    }
}

fn take_f32(deque: &mut VecDeque<u8>) -> f32 {
    let bytes = [
        deque.pop_front().unwrap_or(0),
        deque.pop_front().unwrap_or(0),
        deque.pop_front().unwrap_or(0),
        deque.pop_front().unwrap_or(0),
    ];
    f32::from_le_bytes(bytes)
}

fn record_error(slot: &Arc<Mutex<Option<String>>>, message: String) {
    if let Ok(mut slot) = slot.lock() {
        *slot = Some(message);
    }
}

struct LoopbackClient {
    client: wasapi::AudioClient,
    capture: wasapi::AudioCaptureClient,
    event: wasapi::Handle,
}

fn start_client() -> Result<LoopbackClient, String> {
    initialize_mta()
        .ok()
        .map_err(|cause| format!("COM initialization failed: {cause}"))?;
    let enumerator =
        DeviceEnumerator::new().map_err(|cause| format!("no audio device enumerator: {cause}"))?;
    let device = enumerator
        .get_default_device(Direction::Render)
        .map_err(|cause| format!("no default playback device: {cause}"))?;
    let mut client = device
        .get_iaudioclient()
        .map_err(|cause| format!("cannot open the playback endpoint: {cause}"))?;

    let format = WaveFormat::new(32, 32, SampleType::Float, SAMPLE_RATE as usize, 2, None);
    let (default_period, _) = client
        .get_device_period()
        .map_err(|cause| format!("cannot read the device period: {cause}"))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: default_period,
    };
    client
        // The endpoint is a render device, but the stream direction is capture:
        // that combination is what makes WASAPI set AUDCLNT_STREAMFLAGS_LOOPBACK.
        .initialize_client(&format, Direction::Capture, mode, None)
        .map_err(|cause| format!("cannot initialize the loopback client: {cause}"))?;
    let event = client
        .set_get_eventhandle()
        .map_err(|cause| format!("cannot create the capture event: {cause}"))?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(|cause| format!("cannot open the loopback capture client: {cause}"))?;
    client
        .start_stream()
        .map_err(|cause| format!("cannot start the loopback stream: {cause}"))?;

    Ok(LoopbackClient {
        client,
        capture,
        event,
    })
}
