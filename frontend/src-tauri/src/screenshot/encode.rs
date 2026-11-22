//! WebP encoding for captured frames.

use crate::error::{AppError, AppResult};

pub const DEFAULT_QUALITY: f32 = 82.0;

/// Encode straight RGBA bytes as a lossy WebP image.
pub fn encode_webp(rgba: &[u8], width: u32, height: u32, quality: f32) -> AppResult<Vec<u8>> {
    if width == 0 || height == 0 {
        return Err(AppError::Invalid("screenshot has zero dimensions".into()));
    }
    let expected = width as usize * height as usize * 4;
    if rgba.len() != expected {
        return Err(AppError::Invalid(format!(
            "expected {expected} RGBA bytes, got {}",
            rgba.len()
        )));
    }
    let quality = if quality.is_finite() {
        quality.clamp(1.0, 100.0)
    } else {
        DEFAULT_QUALITY
    };
    let encoder = webp::Encoder::from_rgba(rgba, width, height);
    let memory = encoder.encode(quality);
    if memory.is_empty() {
        return Err(AppError::Invalid("WebP encoder returned no data".into()));
    }
    Ok(memory.to_vec())
}

/// Read the dimensions back out of a WebP payload.
pub fn webp_dimensions(data: &[u8]) -> AppResult<(u32, u32)> {
    let decoder = webp::Decoder::new(data);
    let image = decoder
        .decode()
        .ok_or_else(|| AppError::Invalid("invalid WebP payload".into()))?;
    Ok((image.width(), image.height()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                out.extend_from_slice(&[
                    (x * 255 / width) as u8,
                    (y * 255 / height) as u8,
                    128,
                    255,
                ]);
            }
        }
        out
    }

    #[test]
    fn encodes_a_riff_webp_and_roundtrips_dimensions() {
        let rgba = gradient(320, 180);
        let encoded = encode_webp(&rgba, 320, 180, 82.0).unwrap();
        assert!(encoded.len() > 12);
        assert_eq!(&encoded[0..4], b"RIFF");
        assert_eq!(&encoded[8..12], b"WEBP");
        assert_eq!(webp_dimensions(&encoded).unwrap(), (320, 180));
    }

    #[test]
    fn quality_is_clamped_and_invalid_input_rejected() {
        let rgba = gradient(16, 16);
        assert!(encode_webp(&rgba, 16, 16, 5_000.0).is_ok());
        assert!(encode_webp(&rgba, 16, 16, f32::NAN).is_ok());
        assert!(encode_webp(&rgba, 0, 16, 80.0).is_err());
        assert!(encode_webp(&rgba[..10], 16, 16, 80.0).is_err());
    }

    #[test]
    fn rejects_undecodable_payloads() {
        assert!(webp_dimensions(b"not a webp").is_err());
    }
}
