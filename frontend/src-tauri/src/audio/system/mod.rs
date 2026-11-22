//! Platform system-audio loopback.
//!
//! This module captures what the machine is playing (the far side of a call,
//! a video, a voice memo) as a second, independent stream. It never merges with
//! the microphone at capture time: two archives mean the transcript can label
//! "You" versus "Them" instead of guessing, and a broken system tap cannot
//! corrupt the local microphone take.
//!
//! Backends:
//! - macOS: ScreenCaptureKit audio-only `SCStream`.
//! - Windows: WASAPI loopback on the default render endpoint.
//! - Everything else: unsupported, and the UI is told so.

#[cfg(all(feature = "system-audio", target_os = "macos"))]
mod macos;
#[cfg(all(feature = "system-audio", target_os = "windows"))]
mod windows;

#[cfg(all(feature = "system-audio", target_os = "macos"))]
pub use macos::SystemAudioCapture;
#[cfg(all(feature = "system-audio", target_os = "windows"))]
pub use windows::SystemAudioCapture;

/// Whether this build and platform can capture system audio.
pub fn system_audio_supported() -> bool {
    cfg!(all(
        feature = "system-audio",
        any(target_os = "macos", target_os = "windows")
    ))
}

/// Stable identifier for the loopback backend, or `None` when unavailable.
pub fn system_audio_backend() -> Option<&'static str> {
    #[cfg(all(feature = "system-audio", target_os = "macos"))]
    {
        Some("screencapturekit")
    }
    #[cfg(all(feature = "system-audio", target_os = "windows"))]
    {
        Some("wasapi")
    }
    #[cfg(not(all(
        feature = "system-audio",
        any(target_os = "macos", target_os = "windows")
    )))]
    {
        None
    }
}

/// Whether the OS permission needed by the loopback backend is currently granted.
pub fn system_audio_permission_granted() -> bool {
    #[cfg(all(feature = "system-audio", target_os = "macos"))]
    {
        macos::permission_granted()
    }
    #[cfg(not(all(feature = "system-audio", target_os = "macos")))]
    {
        true
    }
}

/// Ask the OS for loopback permission when the platform requires it.
pub fn request_system_audio_permission() -> bool {
    #[cfg(all(feature = "system-audio", target_os = "macos"))]
    {
        macos::request_permission()
    }
    #[cfg(not(all(feature = "system-audio", target_os = "macos")))]
    {
        system_audio_supported()
    }
}

/// A running system-audio source.
///
/// The real implementations live in the platform modules; this stub keeps the
/// type available on every target so callers do not need eight `cfg`s.
#[cfg(not(all(
    feature = "system-audio",
    any(target_os = "macos", target_os = "windows")
)))]
pub struct SystemAudioCapture {
    _private: (),
}

#[cfg(not(all(
    feature = "system-audio",
    any(target_os = "macos", target_os = "windows")
)))]
impl SystemAudioCapture {
    pub fn start() -> crate::error::AppResult<Self> {
        Err(crate::error::AppError::Capture(
            "system audio capture is not available in this build; record with the microphone instead"
                .into(),
        ))
    }

    pub fn sample_rate(&self) -> u32 {
        48_000
    }

    pub fn device_name(&self) -> &str {
        "system audio"
    }

    pub fn drain(&self, _max: usize) -> Vec<Vec<f32>> {
        Vec::new()
    }

    pub fn recv_timeout(&self, _timeout: std::time::Duration) -> Option<Vec<f32>> {
        None
    }

    pub fn dropped_blocks(&self) -> u64 {
        0
    }

    pub fn last_error(&self) -> Option<String> {
        None
    }
}
