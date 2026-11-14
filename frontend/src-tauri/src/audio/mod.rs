//! Meeting audio capture and persistence.
//!
//! `memo-audio-capture` owns the portable DSP; this module owns the process
//! lifecycle: one session per recording, levels to the HUD, and a finalized WAV
//! in the meeting's media directory.

pub mod session;
pub mod system;

pub use session::{
    AudioCaptureOutcome, AudioCaptureSession, AudioCaptureTake, AudioChannel, AudioLevelSample,
};
pub use system::{system_audio_backend, system_audio_supported};
