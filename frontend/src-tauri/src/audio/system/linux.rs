//! Linux system-audio capture through the PulseAudio/PipeWire monitor source.
//!
//! Every PulseAudio sink (and every PipeWire node, via pipewire-pulse) exposes a
//! `<sink>.monitor` source that carries exactly what the machine is playing.
//! Recording from the default sink's monitor is the Linux equivalent of
//! ScreenCaptureKit audio on macOS or WASAPI loopback on Windows, and libpulse
//! is present on any desktop with working audio, so one backend covers both
//! sound servers.
//!
//! The read callback runs on the PulseAudio mainloop thread and never blocks:
//! it hands fixed 10 ms blocks to a bounded channel and counts drops when the
//! consumer stalls. Audio arrives as native-endian `f32`; every tier-1 Linux
//! target is little-endian, which matches PA_SAMPLE_FLOAT32LE.

use std::collections::VecDeque;
use std::ffi::{CStr, CString};
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use libpulse_sys as pa;

use crate::error::{AppError, AppResult};

const SAMPLE_RATE: u32 = 48_000;
const QUEUE_BLOCKS: usize = 96;
const BLOCK_FRAMES: usize = 480;
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const SERVER_NAME: &CStr = c"usememo-system-audio";

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
                run_monitor(
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
                Err(AppError::Capture(
                    "PulseAudio monitor capture did not start in time".into(),
                ))
            }
        }
    }

    pub fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }

    pub fn device_name(&self) -> &str {
        "System audio · PulseAudio monitor"
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

/// Shared state reached by the PulseAudio read callback, which runs on the
/// mainloop thread. The worker never touches it directly; teardown removes
/// the callback and stops the mainloop before the box is freed.
struct AudioSink {
    tx: SyncSender<Vec<f32>>,
    dropped: Arc<AtomicU64>,
    pending: Mutex<VecDeque<f32>>,
}

extern "C" fn read_callback(stream: *mut pa::pa_stream, nbytes: usize, userdata: *mut c_void) {
    unsafe {
        let sink = &*(userdata as *const AudioSink);
        let mut data: *const c_void = std::ptr::null();
        let mut available: usize = 0;
        if pa::pa_stream_peek(stream, &mut data, &mut available) != 0 || data.is_null() {
            pa::pa_stream_drop(stream);
            return;
        }
        let frames = available / std::mem::size_of::<f32>();
        let samples = std::slice::from_raw_parts(data as *const f32, frames);
        let mut pending = match sink.pending.lock() {
            Ok(pending) => pending,
            Err(poisoned) => poisoned.into_inner(),
        };
        pending.extend(samples.iter().copied());
        while pending.len() >= BLOCK_FRAMES {
            let block: Vec<f32> = pending.drain(..BLOCK_FRAMES).collect();
            if sink.tx.try_send(block).is_err() {
                sink.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        drop(pending);
        pa::pa_stream_drop(stream);
        let _ = nbytes;
    }
}

extern "C" fn server_info_callback(
    _context: *mut pa::pa_context,
    info: *const pa::pa_server_info,
    userdata: *mut c_void,
) {
    unsafe {
        let tx = &*(userdata as *const mpsc::Sender<Option<String>>);
        // PulseAudio invokes this callback with a null info pointer on failure.
        let sink_name = if info.is_null() || (*info).default_sink_name.is_null() {
            None
        } else {
            CStr::from_ptr((*info).default_sink_name)
                .to_str()
                .ok()
                .map(str::to_owned)
        };
        let _ = tx.send(sink_name);
    }
}

fn pulse_error(context: *mut pa::pa_context) -> String {
    unsafe {
        let errno = pa::pa_context_errno(context);
        let message = CStr::from_ptr(pa::pa_strerror(errno))
            .to_str()
            .unwrap_or("unknown PulseAudio error");
        format!("PulseAudio error {errno}: {message}")
    }
}

/// Everything the worker owns once PulseAudio has handed over a live stream.
struct LiveCapture {
    mainloop: *mut pa::pa_threaded_mainloop,
    context: *mut pa::pa_context,
    stream: *mut pa::pa_stream,
    sink: *mut AudioSink,
}

impl LiveCapture {
    /// Polls the connection and stream state; returns an error message once
    /// either has failed so the session can warn that call audio stopped.
    fn health_error(&self) -> Option<String> {
        unsafe {
            pa::pa_threaded_mainloop_lock(self.mainloop);
            let context_state = pa::pa_context_get_state(self.context);
            let stream_state = pa::pa_stream_get_state(self.stream);
            let errno = pa::pa_context_errno(self.context);
            pa::pa_threaded_mainloop_unlock(self.mainloop);
            match context_state {
                pa::PA_CONTEXT_FAILED | pa::PA_CONTEXT_TERMINATED => {
                    let message = CStr::from_ptr(pa::pa_strerror(errno))
                        .to_str()
                        .unwrap_or("unknown PulseAudio error");
                    return Some(format!("PulseAudio connection lost: {message}"));
                }
                _ => {}
            }
            match stream_state {
                pa::PA_STREAM_FAILED | pa::PA_STREAM_TERMINATED => {
                    Some("the PulseAudio monitor source stopped".into())
                }
                _ => None,
            }
        }
    }

    fn teardown(self) {
        unsafe {
            // The mainloop is always present: it is created before LiveCapture.
            pa::pa_threaded_mainloop_lock(self.mainloop);
            if !self.stream.is_null() {
                pa::pa_stream_set_read_callback(self.stream, None, std::ptr::null_mut());
                pa::pa_stream_disconnect(self.stream);
                pa::pa_stream_unref(self.stream);
            }
            if !self.context.is_null() {
                pa::pa_context_disconnect(self.context);
                pa::pa_context_unref(self.context);
            }
            pa::pa_threaded_mainloop_unlock(self.mainloop);
            pa::pa_threaded_mainloop_stop(self.mainloop);
            pa::pa_threaded_mainloop_free(self.mainloop);
            if !self.sink.is_null() {
                drop(Box::from_raw(self.sink));
            }
        }
    }
}

fn run_monitor(
    audio_tx: SyncSender<Vec<f32>>,
    setup_tx: mpsc::Sender<Result<(), String>>,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
) {
    let live = unsafe { connect_monitor(&audio_tx, &dropped) };
    match live {
        Ok(live) => {
            let _ = setup_tx.send(Ok(()));
            while !stop.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(50));
                if let Some(message) = live.health_error() {
                    record_error(&error, message);
                    break;
                }
            }
            live.teardown();
        }
        Err(message) => {
            record_error(&error, message.clone());
            let _ = setup_tx.send(Err(message));
        }
    }
}

/// Connect to the PulseAudio server, resolve the default sink's monitor source,
/// and start a 48 kHz mono float stream on it.
///
/// # Safety
/// All PulseAudio calls happen on this worker thread while it owns the
/// threaded mainloop lock; the read callback only touches the shared sink
/// state through atomics and a mutex.
unsafe fn connect_monitor(
    audio_tx: &SyncSender<Vec<f32>>,
    dropped: &Arc<AtomicU64>,
) -> Result<LiveCapture, String> {
    let mainloop = pa::pa_threaded_mainloop_new();
    if mainloop.is_null() {
        return Err("cannot create the PulseAudio mainloop".into());
    }
    if pa::pa_threaded_mainloop_start(mainloop) != 0 {
        pa::pa_threaded_mainloop_free(mainloop);
        return Err("cannot start the PulseAudio mainloop".into());
    }

    let mut live = LiveCapture {
        mainloop,
        context: std::ptr::null_mut(),
        stream: std::ptr::null_mut(),
        sink: std::ptr::null_mut(),
    };

    pa::pa_threaded_mainloop_lock(mainloop);
    let api = pa::pa_threaded_mainloop_get_api(mainloop);
    let context = pa::pa_context_new(api, SERVER_NAME.as_ptr());
    if context.is_null() {
        pa::pa_threaded_mainloop_unlock(mainloop);
        live.teardown();
        return Err("cannot create the PulseAudio context".into());
    }
    live.context = context;

    if pa::pa_context_connect(context, std::ptr::null(), 0, std::ptr::null()) != 0 {
        let message = pulse_error(context);
        pa::pa_threaded_mainloop_unlock(mainloop);
        live.teardown();
        return Err(format!("cannot connect to PulseAudio: {message}"));
    }

    match wait_context_ready(context, mainloop) {
        Ok(()) => {}
        Err(message) => {
            pa::pa_threaded_mainloop_unlock(mainloop);
            live.teardown();
            return Err(message);
        }
    }
    let device = match default_monitor_device(context, mainloop) {
        Ok(device) => device,
        Err(message) => {
            pa::pa_threaded_mainloop_unlock(mainloop);
            live.teardown();
            return Err(message);
        }
    };
    let device_c = CString::new(device).map_err(|_| "invalid monitor device name".to_string())?;

    let spec = pa::pa_sample_spec {
        format: pa::PA_SAMPLE_FLOAT32LE,
        rate: SAMPLE_RATE,
        channels: 1,
    };
    let stream = pa::pa_stream_new(context, SERVER_NAME.as_ptr(), &spec, std::ptr::null());
    if stream.is_null() {
        let message = pulse_error(context);
        pa::pa_threaded_mainloop_unlock(mainloop);
        live.teardown();
        return Err(format!("cannot create the capture stream: {message}"));
    }
    live.stream = stream;

    let sink = Box::into_raw(Box::new(AudioSink {
        tx: audio_tx.clone(),
        dropped: Arc::clone(dropped),
        pending: Mutex::new(VecDeque::with_capacity(BLOCK_FRAMES * 8)),
    }));
    live.sink = sink;
    pa::pa_stream_set_read_callback(stream, Some(read_callback), sink as *mut c_void);

    if pa::pa_stream_connect_record(stream, device_c.as_ptr(), std::ptr::null(), 0) != 0 {
        let message = pulse_error(context);
        pa::pa_threaded_mainloop_unlock(mainloop);
        live.teardown();
        return Err(format!("cannot open the monitor source: {message}"));
    }
    match wait_stream_ready(stream, mainloop) {
        Ok(()) => {}
        Err(message) => {
            pa::pa_threaded_mainloop_unlock(mainloop);
            live.teardown();
            return Err(message);
        }
    }
    pa::pa_threaded_mainloop_unlock(mainloop);
    Ok(live)
}

/// The caller must hold the mainloop lock; returns with it still held.
///
/// `pa_threaded_mainloop_wait` cannot be used here: it blocks while the lock
/// is held, and the mainloop thread needs that same lock to dispatch the very
/// events that would advance the state. Polling with the lock released lets
/// the mainloop thread make progress between checks.
unsafe fn wait_context_ready(
    context: *mut pa::pa_context,
    mainloop: *mut pa::pa_threaded_mainloop,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + SETUP_TIMEOUT;
    loop {
        match pa::pa_context_get_state(context) {
            pa::PA_CONTEXT_READY => return Ok(()),
            pa::PA_CONTEXT_FAILED | pa::PA_CONTEXT_TERMINATED => {
                return Err(pulse_error(context));
            }
            _ => {}
        }
        if std::time::Instant::now() >= deadline {
            return Err("timed out waiting for PulseAudio".into());
        }
        pa::pa_threaded_mainloop_unlock(mainloop);
        std::thread::sleep(Duration::from_millis(10));
        pa::pa_threaded_mainloop_lock(mainloop);
    }
}

/// The caller must hold the mainloop lock. Resolves `<default sink>.monitor`.
unsafe fn default_monitor_device(
    context: *mut pa::pa_context,
    mainloop: *mut pa::pa_threaded_mainloop,
) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Option<String>>();
    // The callback runs on the mainloop thread and may still be pending when
    // the request times out, so the sender must outlive this function. Heap
    // it: on success the callback has already fired and the box is reclaimed;
    // on timeout the box is deliberately leaked (a few bytes, once per failed
    // capture start) so a late reply cannot touch freed stack memory.
    let tx = Box::into_raw(Box::new(tx));
    let operation =
        pa::pa_context_get_server_info(context, Some(server_info_callback), tx as *mut c_void);
    // The callback runs on the mainloop thread, which needs the lock released.
    pa::pa_threaded_mainloop_unlock(mainloop);
    let sink_name = rx.recv_timeout(SETUP_TIMEOUT);
    pa::pa_threaded_mainloop_lock(mainloop);
    unsafe {
        if sink_name.is_ok() {
            drop(Box::from_raw(tx));
        } else {
            std::mem::forget(Box::from_raw(tx));
        }
    }
    if !operation.is_null() {
        pa::pa_operation_unref(operation);
    }
    match sink_name {
        Ok(Some(name)) if !name.is_empty() => Ok(format!("{name}.monitor")),
        Ok(_) => Err("PulseAudio has no default output device to monitor".into()),
        Err(_) => Err("PulseAudio did not answer the server info request".into()),
    }
}

/// The caller must hold the mainloop lock; returns with it still held.
/// Polls with the lock released for the same reason as `wait_context_ready`.
unsafe fn wait_stream_ready(
    stream: *mut pa::pa_stream,
    mainloop: *mut pa::pa_threaded_mainloop,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + SETUP_TIMEOUT;
    loop {
        match pa::pa_stream_get_state(stream) {
            pa::PA_STREAM_READY => return Ok(()),
            pa::PA_STREAM_FAILED | pa::PA_STREAM_TERMINATED => {
                return Err("the monitor source failed to start".into());
            }
            _ => {}
        }
        if std::time::Instant::now() >= deadline {
            return Err("timed out waiting for the monitor source".into());
        }
        pa::pa_threaded_mainloop_unlock(mainloop);
        std::thread::sleep(Duration::from_millis(10));
        pa::pa_threaded_mainloop_lock(mainloop);
    }
}

fn record_error(slot: &Arc<Mutex<Option<String>>>, message: String) {
    if let Ok(mut slot) = slot.lock() {
        *slot = Some(message);
    }
}
