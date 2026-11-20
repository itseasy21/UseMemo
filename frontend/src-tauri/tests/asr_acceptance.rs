//! Real end-to-end speech recognition acceptance.
//!
//! This test is gated because it needs a multi-hundred-megabyte model that is
//! not vendored in the repository. It is the only test that proves the shipping
//! ASR path actually turns audio into accurate text; the unit tests around it
//! only prove chunking, silence detection, and text cleanup.
//!
//! Run it with real artifacts:
//!
//! ```sh
//! MEMO_ASR_E2E=1 \
//! MEMO_ASR_MODEL=/path/to/ggml-small-q5_1.bin \
//! MEMO_ASR_WAV=/path/to/speech-16k.wav \
//! cargo test -p use-memo --test asr_acceptance -- --nocapture
//! ```
//!
//! Generate the WAV on macOS with:
//!
//! ```sh
//! say -o /tmp/asr-sample.wav --data-format=LEI16@16000 \
//!   "The quarterly launch review starts on Monday. We decided to delay the beta by two weeks."
//! ```

#![cfg(feature = "asr")]

use std::env;
use std::path::PathBuf;

use use_memo_lib::asr::{block_ranges, clean_text, is_silent, AsrEngine, WhisperEngine, BLOCK_MS};

fn sample_rate_16k(samples: Vec<f32>, rate: u32) -> Vec<f32> {
    if rate == 16_000 {
        return samples;
    }
    let mut resampler = memo_audio_capture::SincResampler::new(rate, 16_000).unwrap();
    let mut out = Vec::new();
    resampler.process(&samples, &mut out);
    resampler.finish(&mut out);
    out
}

#[test]
#[ignore = "requires local ggml-small-q5_1.bin and speech WAV; run with MEMO_ASR_E2E=1 cargo test -- --ignored"]
fn whisper_transcribes_known_speech_with_timestamps() {
    if env::var("MEMO_ASR_E2E").as_deref() != Ok("1") {
        eprintln!("skipping: set MEMO_ASR_E2E=1 to run the real ASR acceptance test");
        return;
    }

    let model_path = env::var("MEMO_ASR_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp/litert-release/ggml-small-q5_1.bin"));
    let wav_path = env::var("MEMO_ASR_WAV")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp/asr-sample.wav"));

    assert!(
        model_path.is_file(),
        "ASR model is missing at {}",
        model_path.display()
    );
    assert!(
        wav_path.is_file(),
        "speech sample is missing at {}; generate one with `say`",
        wav_path.display()
    );

    let audio = memo_audio_capture::wav::read_wav(&wav_path).expect("decode the sample WAV");
    let samples = sample_rate_16k(audio.samples, audio.sample_rate);
    let duration_ms = (samples.len() as i128 * 1_000 / 16_000) as i64;
    assert!(duration_ms > 2_000, "sample is too short: {duration_ms} ms");

    let engine = WhisperEngine::load(&model_path, "whisper-small").expect("load whisper");
    let per_block = (16_000 * BLOCK_MS / 1_000) as usize;
    let ranges = block_ranges(samples.len(), per_block);
    assert!(!ranges.is_empty());

    let mut text = String::new();
    let mut timed_segments = 0usize;
    for (start, end) in ranges {
        let block = &samples[start..end];
        if is_silent(block) {
            continue;
        }
        for segment in engine.transcribe(block, Some("en")).expect("transcribe") {
            if let Some(cleaned) = clean_text(&segment.text) {
                if segment.end_ms > segment.start_ms {
                    timed_segments += 1;
                }
                text.push_str(&cleaned);
                text.push(' ');
            }
        }
    }

    let normalized = text.to_lowercase();
    eprintln!("ASR transcript: {text}");
    assert!(
        normalized.contains("beta"),
        "expected the spoken sentence in the transcript, got: {text}"
    );
    assert!(
        normalized.contains("week"),
        "expected 'two weeks' in the transcript, got: {text}"
    );
    assert!(
        timed_segments > 0,
        "no segment carried a positive timestamp range"
    );
}
