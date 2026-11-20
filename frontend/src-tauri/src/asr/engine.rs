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

/// Per-window decoding options passed to an [`AsrEngine`].
#[derive(Debug, Clone, Copy, Default)]
pub struct AsrOptions<'a> {
    pub language: Option<&'a str>,
    pub initial_prompt: Option<&'a str>,
}

/// A loaded speech-to-text engine.
///
/// `transcribe` is synchronous because every backend we care about (whisper.cpp,
/// LiteRT-LM, ONNX) is synchronous and CPU/GPU-bound. Callers run it on a blocking
/// pool; making the trait `async` would only move `spawn_blocking` inward.
pub trait AsrEngine: Send + Sync {
    fn engine_id(&self) -> &str;
    fn model_id(&self) -> &str;
    /// Decode one block of 16 kHz mono samples. Timestamps are block-relative.
    fn transcribe(&self, samples_16k: &[f32], language: Option<&str>)
        -> AppResult<Vec<AsrSegment>>;

    /// Decode one block of 16 kHz mono samples with optional domain prompt biasing.
    fn transcribe_with_options(
        &self,
        samples_16k: &[f32],
        options: AsrOptions<'_>,
    ) -> AppResult<Vec<AsrSegment>> {
        self.transcribe(samples_16k, options.language)
    }
}

/// Sample ranges for `total` samples split into fixed `per_block` windows.
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

/// Pause-aware VAD sample ranges near `max_block_samples` (typically 480,000 = 30s).
///
/// Instead of slicing blindly at exact 30.000s boundaries—which frequently cuts
/// spoken words mid-syllable—this scans the trailing 20% of each candidate block
/// in 100 ms (`1,600` sample) energy frames and splits at the lowest-RMS pause
/// boundary. Every sample in `0..samples_16k.len()` is covered once without gaps.
pub fn vad_block_ranges(samples_16k: &[f32], max_block_samples: usize) -> Vec<(usize, usize)> {
    let total = samples_16k.len();
    if total == 0 || max_block_samples == 0 {
        return Vec::new();
    }
    if total <= max_block_samples {
        return vec![(0, total)];
    }

    const FRAME_SAMPLES: usize = 1_600; // 100 ms @ 16 kHz
    let min_block_samples = (max_block_samples * 4 / 5).max(FRAME_SAMPLES);
    let mut ranges = Vec::with_capacity(total.div_ceil(min_block_samples));
    let mut start = 0usize;

    while start < total {
        let remaining = total - start;
        if remaining <= max_block_samples {
            ranges.push((start, total));
            break;
        }

        let search_start = start + min_block_samples;
        let search_end = start + max_block_samples;
        let mut best_cut = search_end;
        let mut lowest_energy = f64::INFINITY;

        let mut cursor = search_start;
        while cursor + FRAME_SAMPLES <= search_end {
            let window = &samples_16k[cursor..cursor + FRAME_SAMPLES];
            let mut sum = 0.0f64;
            for &sample in window {
                let v = if sample.is_finite() {
                    sample as f64
                } else {
                    0.0
                };
                sum += v * v;
            }
            let mean_sq = sum / FRAME_SAMPLES as f64;
            if mean_sq <= lowest_energy {
                lowest_energy = mean_sq;
                best_cut = cursor + FRAME_SAMPLES / 2;
            }
            cursor += FRAME_SAMPLES / 2;
        }

        let end = best_cut.clamp(start + 1, total);
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

    #[test]
    fn vad_ranges_split_at_quiet_pause_and_cover_every_sample() {
        let max_block = 480_000; // 30s @ 16 kHz
                                 // Fill 40s with loud tone, then carve a 400ms silent pause around 26.5s.
        let mut samples: Vec<f32> = (0..640_000)
            .map(|n| (2.0 * std::f32::consts::PI * 220.0 * n as f32 / 16_000.0).sin() * 0.4)
            .collect();
        let pause_start = 26 * 16_000 + 8_000;
        let pause_end = pause_start + 6_400;
        samples[pause_start..pause_end].fill(0.0);

        let ranges = vad_block_ranges(&samples, max_block);
        assert_eq!(ranges.len(), 2);
        let (first_start, first_end) = ranges[0];
        let (second_start, second_end) = ranges[1];
        assert_eq!(first_start, 0);
        assert!(
            (pause_start..=pause_end).contains(&first_end),
            "expected split inside silent pause [{pause_start}..{pause_end}], got {first_end}"
        );
        assert_eq!(second_start, first_end);
        assert_eq!(second_end, samples.len());
    }
}
