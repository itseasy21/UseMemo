//! Engine-independent transcription primitives.

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// Window size handed to the engine. Whisper's encoder is trained on 30-second
/// windows, so this is the natural unit: no padding waste, no context split.
pub const BLOCK_MS: i64 = 30_000;

/// Blocks quieter than this are not worth decoding. Speech rarely sits below
/// -55 dBFS RMS at 16 kHz, and skipping silence is the cheapest speedup
/// available on a laptop CPU.
pub const SILENCE_DBFS: f32 = -55.0;

/// One recognized utterance, relative to the start of the decoded block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// A loaded speech-to-text engine.
///
/// `transcribe` is synchronous because every backend we care about (whisper.cpp,
/// LiteRT-LM, ONNX) is synchronous and CPU-bound. Callers run it on a blocking
/// pool; making the trait `async` would only move `spawn_blocking` inward.
pub trait AsrEngine: Send + Sync {
    fn engine_id(&self) -> &str;
    fn model_id(&self) -> &str;
    /// Decode one block of 16 kHz mono samples. Timestamps are block-relative.
    fn transcribe(&self, samples_16k: &[f32], language: Option<&str>)
        -> AppResult<Vec<AsrSegment>>;
}

/// Sample ranges for `total` samples split into `per_block` windows.
///
/// The final window is short, which is fine: the engine pads it.
pub fn block_ranges(total: usize, per_block: usize) -> Vec<(usize, usize)> {
    if total == 0 || per_block == 0 {
        return Vec::new();
    }
    let mut ranges = Vec::with_capacity(total.div_ceil(per_block));
    let mut start = 0;
    while start < total {
        let end = (start + per_block).min(total);
        ranges.push((start, end));
        start = end;
    }
    ranges
}

/// True when a block carries no usable speech energy.
pub fn is_silent(samples: &[f32]) -> bool {
    if samples.is_empty() {
        return true;
    }
    let mut sum = 0.0f64;
    for sample in samples {
        let value = if sample.is_finite() { *sample } else { 0.0 };
        sum += (value as f64) * (value as f64);
    }
    let rms = (sum / samples.len() as f64).sqrt() as f32;
    if rms <= 1e-7 {
        return true;
    }
    let dbfs = 20.0 * rms.log10();
    dbfs <= SILENCE_DBFS
}

/// Strip decoder artifacts and reject non-speech annotations.
///
/// Whisper emits bracketed cues such as `[BLANK_AUDIO]`, `(music playing)`, and
/// `♪` for silence or noise. Storing those as transcript text makes the vault
/// and the grounded synthesis prompt worse, so they are dropped.
pub fn clean_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lowered = trimmed.to_lowercase();
    const NOISE: &[&str] = &[
        "[blank_audio]",
        "[silence]",
        "[music]",
        "(music)",
        "[applause]",
        "[inaudible]",
        "(inaudible)",
        "[no speech]",
    ];
    if NOISE.contains(&lowered.as_str()) {
        return None;
    }
    // A block that is only bracketed cues or musical notes carries no content.
    let stripped: String = trimmed
        .chars()
        .filter(|c| !matches!(c, '♪' | '♫'))
        .collect();
    let stripped = stripped.trim();
    if stripped.is_empty() {
        return None;
    }
    if stripped.starts_with('[') && stripped.ends_with(']') {
        return None;
    }
    if stripped.starts_with('(') && stripped.ends_with(')') {
        return None;
    }
    Some(stripped.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_cover_every_sample_exactly_once() {
        let ranges = block_ranges(100, 30);
        assert_eq!(ranges, vec![(0, 30), (30, 60), (60, 90), (90, 100)]);
        let covered: usize = ranges.iter().map(|(start, end)| end - start).sum();
        assert_eq!(covered, 100);
    }

    #[test]
    fn ranges_handle_empty_and_exact_multiples() {
        assert!(block_ranges(0, 480_000).is_empty());
        assert!(block_ranges(100, 0).is_empty());
        assert_eq!(block_ranges(60, 30), vec![(0, 30), (30, 60)]);
    }

    #[test]
    fn silence_detection_separates_tones_from_zeroes() {
        assert!(is_silent(&[]));
        assert!(is_silent(&vec![0.0; 16_000]));
        let tone: Vec<f32> = (0..16_000)
            .map(|n| (2.0 * std::f32::consts::PI * 220.0 * n as f32 / 16_000.0).sin() * 0.3)
            .collect();
        assert!(!is_silent(&tone));
    }

    #[test]
    fn non_finite_samples_do_not_fake_signal() {
        assert!(is_silent(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY]));
    }

    #[test]
    fn decoder_noise_is_dropped() {
        assert_eq!(clean_text("  "), None);
        assert_eq!(clean_text("[BLANK_AUDIO]"), None);
        assert_eq!(clean_text("(music playing)"), None);
        assert_eq!(clean_text("♪ ♪ ♪"), None);
        assert_eq!(clean_text("[Music]"), None);
    }

    #[test]
    fn real_speech_is_preserved_and_trimmed() {
        assert_eq!(
            clean_text("  We decided to delay the beta by two weeks.  "),
            Some("We decided to delay the beta by two weeks.".to_string())
        );
        assert_eq!(clean_text("Okay."), Some("Okay.".to_string()));
    }
}
