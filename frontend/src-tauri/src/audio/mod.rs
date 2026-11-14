//! Meeting audio capture and persistence.
//!
//! `memo-audio-capture` owns the portable DSP; this module owns the process
//! lifecycle: one session per recording, levels to the HUD, and a finalized WAV
//! in the meeting's media directory.

pub mod session;

pub use session::{AudioCaptureOutcome, AudioCaptureSession, AudioLevelSample};
