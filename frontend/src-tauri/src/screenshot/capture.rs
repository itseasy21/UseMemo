//! Platform screenshot backends with display/window targeting and HUD exclusion.
//!
//! On macOS, screenshots are captured directly in-memory via CoreGraphics
//! (`native/macos_capture.m`) with zero `/tmp` files, automatic HUD exclusion,
//! optional window/display pinning, and hardware-accelerated 1920px max-width
//! downscaling before WebP encoding.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::screenshot::dhash::dhash_rgba;

pub const MAX_SCREENSHOT_WIDTH: u32 = 1_920;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CaptureTarget {
    #[default]
    Auto,
    Display {
        id: u32,
    },
    Window {
        id: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualCaptureTarget {
    pub kind: String,
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub width: u32,
    pub height: u32,
}

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

    fn is_supported(&self) -> bool {
        true
    }

    fn set_target(&self, _target: CaptureTarget) {}

    fn target(&self) -> CaptureTarget {
        CaptureTarget::Auto
    }

    fn list_targets(&self) -> AppResult<Vec<VisualCaptureTarget>> {
        Ok(Vec::new())
    }
}

/// Native platform screen/window capture.
#[derive(Debug, Default)]
pub struct SystemScreenCapture {
    target: RwLock<CaptureTarget>,
}

impl SystemScreenCapture {
    pub fn new() -> Self {
        Self {
            target: RwLock::new(CaptureTarget::Auto),
        }
    }
}

impl ScreenCapture for SystemScreenCapture {
    fn is_supported(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn capture(&self) -> AppResult<CapturedFrame> {
        let current = self
            .target
            .read()
            .map(|guard| *guard)
            .unwrap_or(CaptureTarget::Auto);
        #[cfg(target_os = "macos")]
        {
            macos_ffi::capture_target(current)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = current;
            Err(AppError::Capture(
                "system screenshot backend is not implemented on this platform".into(),
            ))
        }
    }

    fn set_target(&self, target: CaptureTarget) {
        if let Ok(mut guard) = self.target.write() {
            *guard = target;
        }
    }

    fn target(&self) -> CaptureTarget {
        self.target
            .read()
            .map(|guard| *guard)
            .unwrap_or(CaptureTarget::Auto)
    }

    fn list_targets(&self) -> AppResult<Vec<VisualCaptureTarget>> {
        #[cfg(target_os = "macos")]
        {
            macos_ffi::list_targets()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(Vec::new())
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_ffi {
    use std::ffi::CStr;
    use std::os::raw::c_char;

    use super::*;

    unsafe extern "C" {
        fn memo_macos_list_capture_targets(
            out_json: *mut *mut c_char,
            out_error: *mut *mut c_char,
        ) -> i32;

        fn memo_macos_capture_target_rgba(
            target_kind: i32,
            target_id: u32,
            max_width: u32,
            out_rgba: *mut *mut u8,
            out_width: *mut u32,
            out_height: *mut u32,
            out_error: *mut *mut c_char,
        ) -> i32;

        fn memo_macos_free_buffer(ptr: *mut u8);
        fn memo_macos_free_string(ptr: *mut c_char);
    }

    pub fn list_targets() -> AppResult<Vec<VisualCaptureTarget>> {
        let mut out_json: *mut c_char = std::ptr::null_mut();
        let mut out_error: *mut c_char = std::ptr::null_mut();

        let rc = unsafe { memo_macos_list_capture_targets(&mut out_json, &mut out_error) };
        let json_str = if !out_json.is_null() {
            let s = unsafe { CStr::from_ptr(out_json).to_string_lossy().into_owned() };
            unsafe { memo_macos_free_string(out_json) };
            Some(s)
        } else {
            None
        };
        let err_str = if !out_error.is_null() {
            let s = unsafe { CStr::from_ptr(out_error).to_string_lossy().into_owned() };
            unsafe { memo_macos_free_string(out_error) };
            Some(s)
        } else {
            None
        };

        if rc != 0 {
            return Err(AppError::Capture(err_str.unwrap_or_else(|| {
                "could not enumerate macOS capture targets".into()
            })));
        }

        let parsed: Vec<VisualCaptureTarget> =
            serde_json::from_str(json_str.as_deref().unwrap_or("[]"))
                .map_err(|e| AppError::Capture(format!("invalid capture target JSON: {e}")))?;
        Ok(parsed)
    }

    pub fn capture_target(target: CaptureTarget) -> AppResult<CapturedFrame> {
        let (kind_code, target_id) = match target {
            CaptureTarget::Auto => (0i32, 0u32),
            CaptureTarget::Display { id } => (1i32, id),
            CaptureTarget::Window { id } => (2i32, id),
        };

        let mut out_rgba: *mut u8 = std::ptr::null_mut();
        let mut out_width: u32 = 0;
        let mut out_height: u32 = 0;
        let mut out_error: *mut c_char = std::ptr::null_mut();

        let rc = unsafe {
            memo_macos_capture_target_rgba(
                kind_code,
                target_id,
                MAX_SCREENSHOT_WIDTH,
                &mut out_rgba,
                &mut out_width,
                &mut out_height,
                &mut out_error,
            )
        };

        let err_str = if !out_error.is_null() {
            let s = unsafe { CStr::from_ptr(out_error).to_string_lossy().into_owned() };
            unsafe { memo_macos_free_string(out_error) };
            Some(s)
        } else {
            None
        };

        if rc != 0 || out_rgba.is_null() || out_width == 0 || out_height == 0 {
            if !out_rgba.is_null() {
                unsafe { memo_macos_free_buffer(out_rgba) };
            }
            // If a pinned window was closed mid-meeting, fall back gracefully to Auto once.
            if !matches!(target, CaptureTarget::Auto) {
                return capture_target(CaptureTarget::Auto);
            }
            return Err(AppError::Capture(err_str.unwrap_or_else(|| {
                "screen capture failed; grant Screen Recording permission in System Settings".into()
            })));
        }

        let len = out_width as usize * out_height as usize * 4;
        let rgba = unsafe { std::slice::from_raw_parts(out_rgba, len).to_vec() };
        unsafe { memo_macos_free_buffer(out_rgba) };
        CapturedFrame::new(out_width, out_height, rgba)
    }
}

/// Deterministic in-memory frames for tests and `MEMO_SYNTHETIC_CAPTURE=1`.
#[derive(Debug)]
pub struct SyntheticScreenCapture {
    width: u32,
    height: u32,
    counter: AtomicU64,
    target: RwLock<CaptureTarget>,
}

impl SyntheticScreenCapture {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            counter: AtomicU64::new(0),
            target: RwLock::new(CaptureTarget::Auto),
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

    fn set_target(&self, target: CaptureTarget) {
        if let Ok(mut guard) = self.target.write() {
            *guard = target;
        }
    }

    fn target(&self) -> CaptureTarget {
        self.target
            .read()
            .map(|guard| *guard)
            .unwrap_or(CaptureTarget::Auto)
    }

    fn list_targets(&self) -> AppResult<Vec<VisualCaptureTarget>> {
        Ok(vec![VisualCaptureTarget {
            kind: "display".into(),
            id: 1,
            title: "Synthetic Display (320x180)".into(),
            app_name: "Synthetic".into(),
            width: self.width,
            height: self.height,
        }])
    }
}

/// Test hook for the Tauri state; production uses the system backend.
pub fn default_backend() -> Box<dyn ScreenCapture> {
    if std::env::var("MEMO_SYNTHETIC_CAPTURE").as_deref() == Ok("1") {
        Box::new(SyntheticScreenCapture::default())
    } else {
        Box::new(SystemScreenCapture::new())
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
    fn target_roundtrips_and_serializes_cleanly() {
        let capture = SyntheticScreenCapture::new(64, 48);
        assert_eq!(capture.target(), CaptureTarget::Auto);
        capture.set_target(CaptureTarget::Window { id: 42 });
        assert_eq!(capture.target(), CaptureTarget::Window { id: 42 });

        let json = serde_json::to_value(CaptureTarget::Window { id: 42 }).unwrap();
        assert_eq!(json["kind"], "window");
        assert_eq!(json["id"], 42);
    }

    #[test]
    fn rejects_invalid_frames() {
        assert!(CapturedFrame::new(0, 10, vec![]).is_err());
        assert!(CapturedFrame::new(10, 10, vec![0; 10]).is_err());
        assert!(CapturedFrame::new(10, 10, vec![0; 400]).is_ok());
    }
}
