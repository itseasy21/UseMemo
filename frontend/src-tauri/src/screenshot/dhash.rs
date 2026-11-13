//! Difference hash (dHash) for screenshot deduplication.
//!
//! A 9x8 grayscale thumbnail yields 64 bits: one bit per horizontal neighbour
//! comparison. The hash is robust to minor antialiasing and cursor movement but
//! distinguishes slide changes.

use std::path::Path;

use image::imageops::FilterType;
use image::{DynamicImage, GrayImage, ImageBuffer, RgbaImage};

use crate::error::{AppError, AppResult};

pub const DHASH_WIDTH: u32 = 9;
pub const DHASH_HEIGHT: u32 = 8;

pub fn dhash_rgba(rgba: &[u8], width: u32, height: u32) -> AppResult<u64> {
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
    let image: RgbaImage = ImageBuffer::from_raw(width, height, rgba.to_vec())
        .ok_or_else(|| AppError::Invalid("invalid RGBA buffer".into()))?;
    Ok(dhash_image(&DynamicImage::ImageRgba8(image)))
}

pub fn dhash_file(path: &Path) -> AppResult<u64> {
    let image = image::open(path)
        .map_err(|error| AppError::Invalid(format!("cannot decode screenshot: {error}")))?;
    Ok(dhash_image(&image))
}

pub fn dhash_image(image: &DynamicImage) -> u64 {
    let gray = image.to_luma8();
    let small: GrayImage =
        image::imageops::resize(&gray, DHASH_WIDTH, DHASH_HEIGHT, FilterType::Triangle);
    let mut hash = 0u64;
    for y in 0..DHASH_HEIGHT {
        for x in 0..(DHASH_WIDTH - 1) {
            let left = small.get_pixel(x, y)[0];
            let right = small.get_pixel(x + 1, y)[0];
            hash = (hash << 1) | u64::from(right >= left);
        }
    }
    hash
}

pub fn hamming_distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

pub fn is_near_duplicate(a: u64, b: u64, threshold: u32) -> bool {
    hamming_distance(a, b) <= threshold
}

pub fn hash_to_hex(hash: u64) -> String {
    format!("{hash:016x}")
}

pub fn parse_hash(value: &str) -> AppResult<u64> {
    u64::from_str_radix(value.trim(), 16)
        .map_err(|_| AppError::Invalid(format!("invalid dHash hex value: {value}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn solid(width: u32, height: u32, value: u8) -> Vec<u8> {
        vec![value; (width * height * 4) as usize]
    }

    fn striped(width: u32, height: u32, invert: bool) -> Vec<u8> {
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let on = (x / 8 + y / 8) % 2 == 0;
                let value = if on ^ invert { 245 } else { 10 };
                out.extend_from_slice(&[value, value, value, 255]);
            }
        }
        out
    }

    #[test]
    fn identical_frames_hash_equal() {
        let a = striped(180, 120, false);
        let b = striped(180, 120, false);
        let ha = dhash_rgba(&a, 180, 120).unwrap();
        let hb = dhash_rgba(&b, 180, 120).unwrap();
        assert_eq!(ha, hb);
        assert_eq!(hamming_distance(ha, hb), 0);
    }

    #[test]
    fn inverted_and_patterned_frames_differ() {
        let a = dhash_rgba(&striped(180, 120, false), 180, 120).unwrap();
        let b = dhash_rgba(&striped(180, 120, true), 180, 120).unwrap();
        assert!(hamming_distance(a, b) > 6);
        assert!(!is_near_duplicate(a, b, 6));
    }

    #[test]
    fn small_brightness_shift_is_a_near_duplicate() {
        let a = dhash_rgba(&striped(180, 120, false), 180, 120).unwrap();
        let mut shifted = striped(180, 120, false);
        for sample in &mut shifted {
            *sample = sample.saturating_add(3);
        }
        let b = dhash_rgba(&shifted, 180, 120).unwrap();
        assert!(
            is_near_duplicate(a, b, 6),
            "distance={}",
            hamming_distance(a, b)
        );
    }

    #[test]
    fn solid_frames_collapse_to_the_same_hash() {
        let a = dhash_rgba(&solid(64, 64, 0), 64, 64).unwrap();
        let b = dhash_rgba(&solid(64, 64, 255), 64, 64).unwrap();
        assert_eq!(a, b);
        assert_eq!(a, u64::MAX);
    }

    #[test]
    fn rejects_malformed_buffers() {
        assert!(dhash_rgba(&[0, 0, 0], 2, 2).is_err());
        assert!(dhash_rgba(&[], 0, 0).is_err());
    }

    #[test]
    fn hex_roundtrip_and_validation() {
        let hash = 0x1234_5678_9abc_def0u64;
        assert_eq!(parse_hash(&hash_to_hex(hash)).unwrap(), hash);
        assert!(parse_hash("not-a-hash").is_err());
    }

    #[test]
    fn file_hashing_matches_in_memory_hashing() {
        let mut image = RgbImage::new(32, 24);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = Rgb([(x * 8) as u8, (y * 10) as u8, 128]);
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("frame.png");
        image.save(&path).unwrap();
        let from_file = dhash_file(&path).unwrap();
        let from_memory = dhash_image(&DynamicImage::ImageRgb8(image));
        assert_eq!(from_file, from_memory);
    }
}
