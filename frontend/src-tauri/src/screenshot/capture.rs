//! Platform screenshot backends.
//!
//! macOS uses the signed system `screencapture` utility (on-device, no network)
//! and therefore inherits the Screen Recording privacy permission. The
//! synthetic backend is used by tests and the demo harness.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{AppError, AppResult};
use crate::screenshot::dhash::dhash_rgba;

#[derive(Debug, Clone)]
pub struct CapturedFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl CapturedFrame {
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> AppResult<Self> {
        let expected = width as usize * height as usize * 4;
        if width == 0 || height == 0 || rgba.len() != expected {
            return Err(AppError::Capture(format!(
                "invalid frame buffer: {width}x{height}, {} bytes",
                rgba.len()
            )));
        }
        Ok(Self {
            width,
            height,
            rgba,
        })
    }

    pub fn dhash(&self) -> AppResult<u64> {
        dhash_rgba(&self.rgba, self.width, self.height)
    }
}

pub trait ScreenCapture: Send + Sync {
    fn capture(&self) -> AppResult<CapturedFrame>;
}

/// macOS built-in capture. Requires the user to grant Screen Recording in
/// System Settings on first use.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemScreenCapture;

impl ScreenCapture for SystemScreenCapture {
    fn capture(&self) -> AppResult<CapturedFrame> {
        #[cfg(target_os = "macos")]
        {
            capture_macos()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(AppError::Capture(
                "system screenshot backend is not implemented on this platform".into(),
            ))
        }
    }
}

#[cfg(target_os = "macos")]
fn capture_macos() -> AppResult<CapturedFrame> {
    let path = std::env::temp_dir().join(format!("memo-shot-{}.png", uuid::Uuid::now_v7()));
    let output = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "png"])
        .arg(&path)
        .output()
        .map_err(|error| AppError::Capture(format!("cannot launch screencapture: {error}")))?;
    if !output.status.success() || !path.is_file() {
        let _ = std::fs::remove_file(&path);
        return Err(AppError::Capture(
            "screen capture failed; grant Screen Recording permission in System Settings".into(),
        ));
    }
    let image = image::open(&path)?;
    let _ = std::fs::remove_file(&path);
    let rgba = image.to_rgba8();
    CapturedFrame::new(rgba.width(), rgba.height(), rgba.into_raw())
}

/// Deterministic in-memory frames for tests and `MEMO_SYNTHETIC_CAPTURE=1`.
#[derive(Debug)]
pub struct SyntheticScreenCapture {
    width: u32,
    height: u32,
    counter: AtomicU64,
}

impl SyntheticScreenCapture {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            counter: AtomicU64::new(0),
        }
    }

    pub fn frame(&self, seed: u8) -> CapturedFrame {
        let width = self.width;
        let height = self.height;
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for _y in 0..height {
            for x in 0..width {
                let stripe = ((x + seed as u32 * 20) / 24).is_multiple_of(2);
                let value = if stripe { 235 } else { 20 };
                rgba.extend_from_slice(&[value, value, value, 255]);
            }
        }
        CapturedFrame {
            width,
            height,
            rgba,
        }
    }
}

impl Default for SyntheticScreenCapture {
    fn default() -> Self {
        Self::new(320, 180)
    }
}

impl ScreenCapture for SyntheticScreenCapture {
    fn capture(&self) -> AppResult<CapturedFrame> {
        let tick = self.counter.fetch_add(1, Ordering::Relaxed);
        Ok(self.frame((tick / 3) as u8))
    }
}

/// Test hook for the Tauri state; production uses the system backend.
pub fn default_backend() -> Box<dyn ScreenCapture> {
    if std::env::var("MEMO_SYNTHETIC_CAPTURE").as_deref() == Ok("1") {
        Box::new(SyntheticScreenCapture::default())
    } else {
        Box::new(SystemScreenCapture)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_frames_are_valid_and_change_over_time() {
        let capture = SyntheticScreenCapture::new(64, 48);
        let first = capture.capture().unwrap();
        assert_eq!(first.rgba.len(), 64 * 48 * 4);
        assert_eq!((first.width, first.height), (64, 48));
        let mut hashes = Vec::new();
        for _ in 0..6 {
            hashes.push(capture.capture().unwrap().dhash().unwrap());
        }
        assert!(hashes.windows(2).any(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn rejects_invalid_frames() {
        assert!(CapturedFrame::new(0, 10, vec![]).is_err());
        assert!(CapturedFrame::new(10, 10, vec![0; 10]).is_err());
        assert!(CapturedFrame::new(10, 10, vec![0; 400]).is_ok());
    }
}
