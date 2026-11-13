//! Dual-stream mixer: microphone + system audio at a common 48 kHz timeline.
//!
//! Each producer writes into its own bounded ring. The mixer drains both rings
//! in lockstep, trims runaway drift, applies per-source gain and a soft
//! limiter, and advances the meeting clock.

use serde::{Deserialize, Serialize};

use crate::clock::SampleClock;
use crate::error::{AudioError, AudioResult};
use crate::level::{LevelFrame, LevelMeter};
use crate::ring::SampleRing;
use crate::source::SourceKind;

pub const TARGET_SAMPLE_RATE: u32 = 48_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerConfig {
    pub sample_rate: u32,
    pub mic_gain: f32,
    pub system_gain: f32,
    /// Maximum producer drift tolerated before the leading ring is trimmed.
    pub max_skew_ms: u32,
    /// Per-source ring capacity in samples (defaults to ten seconds).
    pub ring_capacity: usize,
}

impl Default for MixerConfig {
    fn default() -> Self {
        Self {
            sample_rate: TARGET_SAMPLE_RATE,
            mic_gain: 1.0,
            system_gain: 0.9,
            max_skew_ms: 250,
            ring_capacity: TARGET_SAMPLE_RATE as usize * 10,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DualStreamMixer {
    config: MixerConfig,
    mic: SampleRing,
    system: SampleRing,
    meter: LevelMeter,
    clock: SampleClock,
    last_level: LevelFrame,
    mic_skew_trimmed: u64,
    system_skew_trimmed: u64,
}

impl Default for DualStreamMixer {
    fn default() -> Self {
        Self::new(MixerConfig::default()).expect("default mixer config is valid")
    }
}

impl DualStreamMixer {
    pub fn new(config: MixerConfig) -> AudioResult<Self> {
        if !(8_000..=192_000).contains(&config.sample_rate) {
            return Err(AudioError::InvalidConfig(
                "sample rate must be between 8 kHz and 192 kHz".into(),
            ));
        }
        if !(0.0..=4.0).contains(&config.mic_gain) || !(0.0..=4.0).contains(&config.system_gain) {
            return Err(AudioError::InvalidConfig(
                "gains must be between 0 and 4".into(),
            ));
        }
        if !(10..=5_000).contains(&config.max_skew_ms) {
            return Err(AudioError::InvalidConfig(
                "maxSkewMs must be between 10 and 5000".into(),
            ));
        }
        let ring_capacity = if config.ring_capacity == 0 {
            config.sample_rate as usize * 10
        } else {
            config.ring_capacity
        };
        Ok(Self {
            mic: SampleRing::new(ring_capacity),
            system: SampleRing::new(ring_capacity),
            meter: LevelMeter::new(),
            clock: SampleClock::new(config.sample_rate),
            last_level: LevelFrame::silence(),
            mic_skew_trimmed: 0,
            system_skew_trimmed: 0,
            config,
        })
    }

    pub fn config(&self) -> &MixerConfig {
        &self.config
    }

    pub fn sample_rate(&self) -> u32 {
        self.config.sample_rate
    }

    pub fn clock(&self) -> &SampleClock {
        &self.clock
    }

    pub fn levels(&self) -> LevelFrame {
        self.last_level
    }

    pub fn push(&mut self, kind: SourceKind, samples: &[f32]) {
        match kind {
            SourceKind::Microphone => {
                self.mic.push_slice(samples);
            }
            SourceKind::System => {
                self.system.push_slice(samples);
            }
        }
    }

    pub fn available(&self, kind: SourceKind) -> usize {
        match kind {
            SourceKind::Microphone => self.mic.len(),
            SourceKind::System => self.system.len(),
        }
    }

    pub fn dropped(&self, kind: SourceKind) -> u64 {
        match kind {
            SourceKind::Microphone => self.mic.dropped(),
            SourceKind::System => self.system.dropped(),
        }
    }

    pub fn skew_trimmed(&self, kind: SourceKind) -> u64 {
        match kind {
            SourceKind::Microphone => self.mic_skew_trimmed,
            SourceKind::System => self.system_skew_trimmed,
        }
    }

    /// Drain both rings into `out`. Returns the number of interleaved mono
    /// frames produced. Missing samples from one producer are treated as
    /// silence so the other stream keeps its timeline.
    pub fn mix_into(&mut self, out: &mut [f32]) -> usize {
        self.align_drift();
        let frames = out.len().min(self.mic.len().max(self.system.len()));
        if frames == 0 {
            return 0;
        }
        for slot in out.iter_mut().take(frames) {
            let mic = self.mic.pop().unwrap_or(0.0) * self.config.mic_gain;
            let system = self.system.pop().unwrap_or(0.0) * self.config.system_gain;
            *slot = soft_limit(mic + system);
        }
        self.last_level = self.meter.process(&out[..frames]);
        self.clock.advance(frames);
        frames
    }

    pub fn mix_vec(&mut self, frames: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; frames];
        let produced = self.mix_into(&mut out);
        out.truncate(produced);
        out
    }

    pub fn reset(&mut self) {
        self.mic.clear();
        self.system.clear();
        self.meter.reset();
        self.clock.reset();
        self.last_level = LevelFrame::silence();
        self.mic_skew_trimmed = 0;
        self.system_skew_trimmed = 0;
    }

    fn align_drift(&mut self) {
        if self.mic.is_empty() || self.system.is_empty() {
            return;
        }
        let max_skew =
            (self.config.sample_rate as u64 * self.config.max_skew_ms as u64 / 1_000) as usize;
        if self.mic.len() > self.system.len() + max_skew {
            let trim = self.mic.len() - self.system.len() - max_skew;
            self.mic.skip(trim);
            self.mic_skew_trimmed += trim as u64;
        } else if self.system.len() > self.mic.len() + max_skew {
            let trim = self.system.len() - self.mic.len() - max_skew;
            self.system.skip(trim);
            self.system_skew_trimmed += trim as u64;
        }
    }
}

/// Transparent below -2 dBFS, then approaches 0 dBFS asymptotically.
pub fn soft_limit(sample: f32) -> f32 {
    if !sample.is_finite() {
        return 0.0;
    }
    let magnitude = sample.abs();
    if magnitude <= 0.8 {
        sample
    } else {
        sample.signum() * (0.8 + 0.2 * ((magnitude - 0.8) / 0.2).tanh())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant(value: f32, count: usize) -> Vec<f32> {
        vec![value; count]
    }

    #[test]
    fn mixes_both_sources_and_advances_clock() {
        let mut mixer = DualStreamMixer::default();
        mixer.push(SourceKind::Microphone, &constant(0.25, 480));
        mixer.push(SourceKind::System, &constant(0.25, 480));
        let mut out = [0.0f32; 480];
        assert_eq!(mixer.mix_into(&mut out), 480);
        assert!((out[0] - (0.25 + 0.225)).abs() < 1e-6);
        assert_eq!(mixer.clock().elapsed_ms(), 10);
        assert!(mixer.levels().peak > 0.0);
    }

    #[test]
    fn missing_stream_is_silence_not_a_stall() {
        let mut mixer = DualStreamMixer::default();
        mixer.push(SourceKind::Microphone, &constant(0.5, 480));
        let mut out = [0.0f32; 480];
        assert_eq!(mixer.mix_into(&mut out), 480);
        assert!((out[0] - 0.5).abs() < 1e-6);
        assert_eq!(mixer.clock().elapsed_ms(), 10);
    }

    #[test]
    fn soft_limiter_never_exceeds_full_scale() {
        let mut mixer = DualStreamMixer::new(MixerConfig {
            mic_gain: 4.0,
            system_gain: 4.0,
            ..MixerConfig::default()
        })
        .unwrap();
        mixer.push(SourceKind::Microphone, &constant(1.0, 96));
        mixer.push(SourceKind::System, &constant(1.0, 96));
        let out = mixer.mix_vec(96);
        assert!(out.iter().all(|sample| sample.abs() <= 1.0));
        assert!(out[0] > 0.99);
    }

    #[test]
    fn leading_stream_is_trimmed_to_the_skew_budget() {
        let mut mixer = DualStreamMixer::new(MixerConfig {
            max_skew_ms: 20,
            ..MixerConfig::default()
        })
        .unwrap();
        // 100 ms of mic, 10 ms of system: keep at most 20 ms of lead.
        mixer.push(SourceKind::Microphone, &constant(0.1, 4_800));
        mixer.push(SourceKind::System, &constant(0.1, 480));
        assert_eq!(mixer.available(SourceKind::Microphone), 4_800);
        let out = mixer.mix_vec(1_440);
        assert_eq!(mixer.skew_trimmed(SourceKind::Microphone), 3_360);
        assert_eq!(out.len(), 1_440);
    }

    #[test]
    fn ring_overflow_is_visible_in_diagnostics() {
        let mut mixer = DualStreamMixer::new(MixerConfig {
            ring_capacity: 100,
            ..MixerConfig::default()
        })
        .unwrap();
        mixer.push(SourceKind::Microphone, &constant(0.1, 150));
        assert_eq!(mixer.dropped(SourceKind::Microphone), 50);
        assert_eq!(mixer.available(SourceKind::Microphone), 100);
    }

    #[test]
    fn rejects_bad_configuration() {
        assert!(DualStreamMixer::new(MixerConfig {
            sample_rate: 0,
            ..MixerConfig::default()
        })
        .is_err());
        assert!(DualStreamMixer::new(MixerConfig {
            mic_gain: 9.0,
            ..MixerConfig::default()
        })
        .is_err());
    }
}
