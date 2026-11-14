//! On-device speech recognition.
//!
//! The engine is deliberately behind a trait: whisper.cpp is the shipping
//! implementation because it runs on macOS, Windows, iOS and Android from one
//! C++ core, but a LiteRT-LM OmniEngine can be dropped in later without touching
//! the transcription pipeline, storage, or UI.
//!
//! Transcription is post-hoc and block-based. A finished take is decoded into
//! 30-second blocks, silent blocks are skipped, and each block is transcribed
//! independently. That keeps peak memory flat for long meetings and lets the UI
//! show real progress instead of a single opaque wait.

pub mod engine;
pub mod transcribe;
#[cfg(feature = "asr")]
pub mod whisper;

pub use engine::{
    block_ranges, clean_text, is_silent, AsrEngine, AsrSegment, BLOCK_MS, SILENCE_DBFS,
};
pub use transcribe::{transcribe_meeting, TranscriptionOutcome};
#[cfg(feature = "asr")]
pub use whisper::WhisperEngine;
