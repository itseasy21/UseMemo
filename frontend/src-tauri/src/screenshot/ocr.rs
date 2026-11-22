//! Native on-device slide OCR (`Apple Vision` on macOS/iOS, `Windows.Media.Ocr`
//! on Windows, deterministic synthetic hook for headless tests).

use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::screenshot::CapturedFrame;

pub trait OcrEngine: Send + Sync {
    fn engine_id(&self) -> &str;
    fn recognize_rgba(&self, width: u32, height: u32, rgba: &[u8]) -> AppResult<String>;

    fn recognize_file(&self, path: &Path) -> AppResult<String> {
        let img = image::open(path)?.to_rgba8();
        self.recognize_rgba(img.width(), img.height(), img.as_raw())
    }

    fn recognize_frame(&self, frame: &CapturedFrame) -> AppResult<String> {
        self.recognize_rgba(frame.width, frame.height, &frame.rgba)
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use std::ffi::CStr;
    use std::os::raw::c_char;

    use super::*;

    unsafe extern "C" {
        fn memo_apple_vision_recognize_rgba(
            rgba: *const u8,
            rgba_len: usize,
            width: u32,
            height: u32,
            out_text: *mut *mut c_char,
            out_error: *mut *mut c_char,
        ) -> i32;

        fn memo_apple_vision_free_string(ptr: *mut c_char);
    }

    pub struct AppleVisionOcr;

    impl OcrEngine for AppleVisionOcr {
        fn engine_id(&self) -> &str {
            "apple-vision"
        }

        fn recognize_rgba(&self, width: u32, height: u32, rgba: &[u8]) -> AppResult<String> {
            let mut out_text: *mut c_char = std::ptr::null_mut();
            let mut out_error: *mut c_char = std::ptr::null_mut();

            let rc = unsafe {
                memo_apple_vision_recognize_rgba(
                    rgba.as_ptr(),
                    rgba.len(),
                    width,
                    height,
                    &mut out_text,
                    &mut out_error,
                )
            };

            let text = if !out_text.is_null() {
                let s = unsafe { CStr::from_ptr(out_text).to_string_lossy().into_owned() };
                unsafe { memo_apple_vision_free_string(out_text) };
                Some(s)
            } else {
                None
            };

            let err = if !out_error.is_null() {
                let s = unsafe { CStr::from_ptr(out_error).to_string_lossy().into_owned() };
                unsafe { memo_apple_vision_free_string(out_error) };
                Some(s)
            } else {
                None
            };

            if rc != 0 {
                return Err(AppError::Capture(format!(
                    "Apple Vision OCR failed: {}",
                    err.unwrap_or_else(|| "unknown error".into())
                )));
            }

            Ok(text.unwrap_or_default().trim().to_string())
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_ocr {
    use super::*;

    pub struct WindowsMediaOcr;

    impl OcrEngine for WindowsMediaOcr {
        fn engine_id(&self) -> &str {
            "windows-media-ocr"
        }

        fn recognize_rgba(&self, width: u32, height: u32, rgba: &[u8]) -> AppResult<String> {
            let tmp_png =
                std::env::temp_dir().join(format!("memo-ocr-{}.png", uuid::Uuid::now_v7()));
            let img_buf = image::RgbaImage::from_raw(width, height, rgba.to_vec())
                .ok_or_else(|| AppError::Capture("invalid RGBA buffer for Windows OCR".into()))?;
            img_buf.save(&tmp_png)?;

            let escaped_path = tmp_png.to_string_lossy().replace('\'', "''");
            let ps_script = format!(
                r#"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
function Await($WinRtTask, $ResultType) {{
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $WinRtTask.GetType().Name }})[0]
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('{escaped_path}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
Write-Output $result.Text
"#
            );

            let output = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                .output();
            let _ = std::fs::remove_file(&tmp_png);

            let output =
                output.map_err(|e| AppError::Capture(format!("Windows OCR launch failed: {e}")))?;
            if !output.status.success() {
                return Err(AppError::Capture(format!(
                    "Windows OCR failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
    }
}

pub struct SyntheticOcr;

impl OcrEngine for SyntheticOcr {
    fn engine_id(&self) -> &str {
        "synthetic-ocr"
    }

    fn recognize_rgba(&self, width: u32, height: u32, _rgba: &[u8]) -> AppResult<String> {
        Ok(format!("Synthetic Slide Capture ({width}x{height})"))
    }
}

pub struct UnavailableOcr;

impl OcrEngine for UnavailableOcr {
    fn engine_id(&self) -> &str {
        "unavailable"
    }

    fn recognize_rgba(&self, _width: u32, _height: u32, _rgba: &[u8]) -> AppResult<String> {
        Err(AppError::Capture(
            "native slide OCR is not available on this OS".into(),
        ))
    }
}

pub fn default_ocr_engine() -> Box<dyn OcrEngine> {
    if std::env::var("MEMO_SYNTHETIC_OCR").as_deref() == Ok("1") {
        return Box::new(SyntheticOcr);
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        Box::new(apple::AppleVisionOcr)
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows_ocr::WindowsMediaOcr)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    {
        Box::new(UnavailableOcr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_ocr_engine_processes_blank_frame_cleanly() {
        std::env::set_var("MEMO_OCR_FAST", "1");
        let engine = default_ocr_engine();
        if engine.engine_id() == "unavailable" {
            return;
        }
        let blank = vec![255u8; 128 * 64 * 4];
        let text = engine.recognize_rgba(128, 64, &blank).unwrap();
        assert!(text.is_empty() || text.contains("Synthetic"));
    }
}
