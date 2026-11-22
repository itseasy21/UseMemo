//! Capture-source abstraction and a deterministic synthetic source.
//!
//! Hardware backends implement [`AudioSource`]. The synthetic source exists so
//! the mixer, clock, and acceptance tests can run without a microphone or a
//! system-audio tap.

use crate::error::{AudioError, AudioResult};
use crate::mixer::TARGET_SAMPLE_RATE;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Microphone,
    System,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::System => "system",
        }
    }
}

pub trait AudioSource: Send {
    fn kind(&self) -> SourceKind;
    fn sample_rate(&self) -> u32;
    /// Fill `out` with up to `out.len()` samples. Returns the number written;
    /// zero means the source is exhausted.
    fn read(&mut self, out: &mut [f32]) -> AudioResult<usize>;
}

/// Deterministic tone-plus-noise source used by tests and by the demo mode.
pub struct SyntheticSource {
    kind: SourceKind,
    sample_rate: u32,
    remaining: u64,
    position: u64,
    frequency: f32,
    amplitude: f32,
    noise_state: u32,
}

impl SyntheticSource {
    pub fn new(kind: SourceKind, sample_rate: u32, duration_ms: u64) -> AudioResult<Self> {
        if sample_rate == 0 {
            return Err(AudioError::InvalidConfig(
                "synthetic sample rate must be positive".into(),
            ));
        }
        let total = (sample_rate as u64 * duration_ms) / 1_000;
        Ok(Self {
            kind,
            sample_rate,
            remaining: total,
            position: 0,
            frequency: match kind {
                SourceKind::Microphone => 220.0,
                SourceKind::System => 330.0,
            },
            amplitude: 0.25,
            noise_state: match kind {
                SourceKind::Microphone => 0x1234_5678,
                SourceKind::System => 0x9abc_def0,
            },
        })
    }

    pub fn with_tone(mut self, frequency: f32, amplitude: f32) -> Self {
        self.frequency = frequency.clamp(20.0, 12_000.0);
        self.amplitude = amplitude.clamp(0.0, 1.0);
        self
    }

    pub fn remaining(&self) -> u64 {
        self.remaining
    }
}

impl AudioSource for SyntheticSource {
    fn kind(&self) -> SourceKind {
        self.kind
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn read(&mut self, out: &mut [f32]) -> AudioResult<usize> {
        let count = out.len().min(self.remaining as usize);
        if count == 0 {
            return Ok(0);
        }
        let fade = (self.sample_rate as u64 / 50).max(1);
        for slot in out.iter_mut().take(count) {
            self.position += 1;
            let phase = 2.0 * std::f32::consts::PI * self.frequency * self.position as f32
                / self.sample_rate as f32;
            self.noise_state = self
                .noise_state
                .wrapping_mul(1_664_525)
                .wrapping_add(1_013_904_223);
            let noise = ((self.noise_state >> 8) as f32 / 8_388_608.0 - 1.0) * 0.01;
            let fade_in = (self.position as f32 / fade as f32).min(1.0);
            let fade_out = (self.remaining as f32 / fade as f32).min(1.0);
            *slot = (phase.sin() * self.amplitude + noise) * fade_in.min(fade_out);
        }
        self.remaining -= count as u64;
        Ok(count)
    }
}

/// Capture pipeline that normalizes each source to [`TARGET_SAMPLE_RATE`] and
/// feeds the mixer. Resamplers are created lazily per source.
pub struct CapturePipeline {
    mixer: crate::mixer::DualStreamMixer,
    mic_rate: Option<u32>,
    system_rate: Option<u32>,
    mic_resampler: Option<crate::resample::SincResampler>,
    system_resampler: Option<crate::resample::SincResampler>,
    scratch: Vec<f32>,
}

impl CapturePipeline {
    pub fn new(mixer: crate::mixer::DualStreamMixer) -> Self {
        Self {
            mixer,
            mic_rate: None,
            system_rate: None,
            mic_resampler: None,
            system_resampler: None,
            scratch: Vec::new(),
        }
    }

    pub fn push(&mut self, kind: SourceKind, input_rate: u32, samples: &[f32]) -> AudioResult<()> {
        if samples.is_empty() {
            return Ok(());
        }
        if input_rate == self.mixer.sample_rate() {
            self.mixer.push(kind, samples);
            return Ok(());
        }
        if input_rate == 0 {
            return Err(AudioError::InvalidConfig(
                "source sample rate must be positive".into(),
            ));
        }
        let (cached_rate, resampler) = match kind {
            SourceKind::Microphone => (&mut self.mic_rate, &mut self.mic_resampler),
            SourceKind::System => (&mut self.system_rate, &mut self.system_resampler),
        };
        if *cached_rate != Some(input_rate) || resampler.is_none() {
            *cached_rate = Some(input_rate);
            *resampler = Some(crate::resample::SincResampler::new(
                input_rate,
                self.mixer.sample_rate(),
            )?);
        }
        self.scratch.clear();
        if let Some(resampler) = resampler {
            resampler.process(samples, &mut self.scratch);
        }
        self.mixer.push(kind, &self.scratch);
        Ok(())
    }

    pub fn mix_into(&mut self, out: &mut [f32]) -> usize {
        self.mixer.mix_into(out)
    }

    pub fn levels(&self) -> crate::level::LevelFrame {
        self.mixer.levels()
    }

    pub fn clock(&self) -> &crate::clock::SampleClock {
        self.mixer.clock()
    }

    pub fn mixer(&self) -> &crate::mixer::DualStreamMixer {
        &self.mixer
    }

    pub fn mixer_mut(&mut self) -> &mut crate::mixer::DualStreamMixer {
        &mut self.mixer
    }

    pub fn target_rate() -> u32 {
        TARGET_SAMPLE_RATE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_source_is_deterministic_and_bounded() {
        let mut a = SyntheticSource::new(SourceKind::Microphone, 48_000, 100).unwrap();
        let mut b = SyntheticSource::new(SourceKind::Microphone, 48_000, 100).unwrap();
        let mut left = [0.0f32; 480];
        let mut right = [0.0f32; 480];
        assert_eq!(a.read(&mut left).unwrap(), 480);
        assert_eq!(b.read(&mut right).unwrap(), 480);
        assert_eq!(left, right);
        assert!(left.iter().all(|sample| sample.abs() <= 1.0));
    }

    #[test]
    fn synthetic_source_stops_at_duration() {
        let mut source = SyntheticSource::new(SourceKind::System, 16_000, 50).unwrap();
        let mut out = [0.0f32; 2_000];
        assert_eq!(source.read(&mut out).unwrap(), 800);
        assert_eq!(source.read(&mut out).unwrap(), 0);
    }

    #[test]
    fn pipeline_resamples_24k_input_to_48k() {
        let mixer = crate::mixer::DualStreamMixer::default();
        let mut pipeline = CapturePipeline::new(mixer);
        let input: Vec<f32> = (0..480)
            .map(|n| (2.0 * std::f32::consts::PI * 440.0 * n as f32 / 24_000.0).sin() * 0.5)
            .collect();
        pipeline
            .push(SourceKind::Microphone, 24_000, &input)
            .unwrap();
        pipeline.push(SourceKind::System, 24_000, &input).unwrap();
        let mut out = vec![0.0f32; 960];
        let produced = pipeline.mix_into(&mut out);
        assert!(produced >= 940, "produced={produced}");
        assert!(out[..produced].iter().all(|sample| sample.abs() <= 1.0));
    }
}
