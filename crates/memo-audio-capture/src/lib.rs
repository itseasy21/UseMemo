//! Clean-room dual-stream audio capture core for the white-label meeting stack.
//!
//! The crate deliberately contains no cloud calls, no usage reporting, and no
//! platform capture bindings. Hardware backends implement [`source::AudioSource`]
//! and push samples into [`mixer::DualStreamMixer`]; the DSP here is portable
//! and unit-tested on any host.
//!
//! Pipeline:
//!
//! ```text
//! microphone ──► resampler ──┐
//!                            ├──► bounded rings ──► mixer ──► 48 kHz mono
//! system tap ──► resampler ──┘                          │
//!                                                       ├──► RMS/peak meter
//!                                                       └──► sample clock
//! ```

pub mod clock;
pub mod error;
pub mod level;
pub mod mixer;
pub mod resample;
pub mod ring;
pub mod source;
pub mod wav;

#[cfg(feature = "hardware")]
pub mod microphone;

pub use clock::{format_timestamp, SampleClock};
pub use error::{AudioError, AudioResult};
pub use level::{LevelFrame, LevelMeter};
pub use mixer::{soft_limit, DualStreamMixer, MixerConfig, TARGET_SAMPLE_RATE};
pub use resample::SincResampler;
pub use ring::SampleRing;
pub use source::{AudioSource, CapturePipeline, SourceKind, SyntheticSource};
pub use wav::{WavSpec, WavWriter};

#[cfg(feature = "hardware")]
pub use microphone::{list_input_devices, MicrophoneCapture, MicrophoneInfo};

/// One second of stereo 48 kHz samples, used to size default buffers.
pub const SAMPLES_PER_SECOND: usize = TARGET_SAMPLE_RATE as usize;
