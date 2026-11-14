//! Band-limited streaming resampler for mono `f32` audio.
//!
//! Capture devices do not share a sample rate. The mixer runs at 48 kHz, so
//! every producer is normalized with a windowed-sinc interpolator. The kernel
//! is precomputed for a fixed number of fractional phases, which keeps the
//! per-sample cost bounded and allocation-free after construction.

use std::f64::consts::PI;

use crate::error::{AudioError, AudioResult};

pub const DEFAULT_TAPS: usize = 17;
pub const DEFAULT_PHASES: usize = 256;

#[derive(Debug, Clone)]
pub struct SincResampler {
    input_rate: u32,
    output_rate: u32,
    ratio: f64,
    taps: usize,
    half: usize,
    phases: usize,
    kernels: Vec<Vec<f32>>,
    buffer: Vec<f32>,
    buffer_start: i64,
    position: f64,
    input_total: i64,
    finished: bool,
}

impl SincResampler {
    pub fn new(input_rate: u32, output_rate: u32) -> AudioResult<Self> {
        Self::with_quality(input_rate, output_rate, DEFAULT_TAPS, DEFAULT_PHASES)
    }

    pub fn with_quality(
        input_rate: u32,
        output_rate: u32,
        taps: usize,
        phases: usize,
    ) -> AudioResult<Self> {
        if input_rate == 0 || output_rate == 0 {
            return Err(AudioError::InvalidConfig(
                "sample rates must be positive".into(),
            ));
        }
        if taps < 5 || taps.is_multiple_of(2) {
            return Err(AudioError::InvalidConfig(
                "taps must be odd and at least 5".into(),
            ));
        }
        if phases < 8 {
            return Err(AudioError::InvalidConfig(
                "phases must be at least 8".into(),
            ));
        }
        let ratio = input_rate as f64 / output_rate as f64;
        let half = taps / 2;
        let kernels = build_kernels(taps, half, phases, output_rate as f64 / input_rate as f64);
        Ok(Self {
            input_rate,
            output_rate,
            ratio,
            taps,
            half,
            phases,
            kernels,
            // Pre-roll zeros let the first output frame see a full filter
            // window without shifting the input timeline.
            buffer: vec![0.0; half],
            buffer_start: -(half as i64),
            position: 0.0,
            input_total: 0,
            finished: false,
        })
    }

    pub fn input_rate(&self) -> u32 {
        self.input_rate
    }

    pub fn output_rate(&self) -> u32 {
        self.output_rate
    }

    pub fn taps(&self) -> usize {
        self.taps
    }

    /// Number of trailing input samples that must be flushed for the filter
    /// window to be fully applied.
    pub fn latency_samples(&self) -> usize {
        self.half
    }

    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        if self.finished || input.is_empty() {
            return;
        }
        self.buffer.extend(input.iter().copied().map(sanitize));
        self.input_total += input.len() as i64;
        self.pump(output, false);
    }

    /// Flush the filter tail. Call once at end of stream; no further input is
    /// accepted afterwards.
    pub fn finish(&mut self, output: &mut Vec<f32>) {
        if self.finished {
            return;
        }
        self.pump(output, true);
        self.finished = true;
        self.buffer.clear();
        self.buffer_start = self.input_total;
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
        self.buffer.extend(std::iter::repeat_n(0.0, self.half));
        self.buffer_start = -(self.half as i64);
        self.position = 0.0;
        self.input_total = 0;
        self.finished = false;
    }

    fn pump(&mut self, output: &mut Vec<f32>, pad: bool) {
        loop {
            let center = self.position.floor() as i64;
            let base = center - self.half as i64;
            let need_end = center + self.half as i64;

            if pad && self.position >= self.input_total as f64 {
                break;
            }

            let buffer_end = self.buffer_start + self.buffer.len() as i64 - 1;
            if need_end > buffer_end {
                if !pad {
                    break;
                }
                let missing = (need_end - buffer_end) as usize;
                self.buffer.extend(std::iter::repeat_n(0.0, missing));
            }

            let frac = self.position - center as f64;
            let phase = ((frac * self.phases as f64).round() as usize).min(self.phases - 1);
            let kernel = &self.kernels[phase];
            let start = (base - self.buffer_start) as usize;
            let mut acc = 0.0f64;
            for (index, weight) in kernel.iter().enumerate() {
                acc += self.buffer[start + index] as f64 * *weight as f64;
            }
            output.push(acc.clamp(-1.0, 1.0) as f32);
            self.position += self.ratio;
        }

        let next_base = self.position.floor() as i64 - self.half as i64;
        let trim = (next_base - self.buffer_start).clamp(0, self.buffer.len() as i64) as usize;
        if trim > 0 {
            self.buffer.drain(..trim);
            self.buffer_start += trim as i64;
        }
    }
}

/// Convenience for offline buffers. Includes the filter flush tail.
pub fn resample_all(input: &[f32], input_rate: u32, output_rate: u32) -> AudioResult<Vec<f32>> {
    let mut resampler = SincResampler::new(input_rate, output_rate)?;
    let mut output = Vec::with_capacity(
        (input.len() as f64 * output_rate as f64 / input_rate as f64).ceil() as usize + 8,
    );
    resampler.process(input, &mut output);
    resampler.finish(&mut output);
    Ok(output)
}

fn build_kernels(taps: usize, half: usize, phases: usize, rate_ratio: f64) -> Vec<Vec<f32>> {
    let cutoff = 0.94 * rate_ratio.min(1.0);
    let mut kernels = Vec::with_capacity(phases);
    for phase in 0..phases {
        let frac = phase as f64 / phases as f64;
        let mut kernel = vec![0.0f32; taps];
        let mut sum = 0.0f64;
        for (index, slot) in kernel.iter_mut().enumerate() {
            let offset = index as f64 - half as f64 - frac;
            let normalized = offset / half as f64;
            if normalized.abs() >= 1.0 {
                continue;
            }
            let sinc = if offset.abs() < 1e-9 {
                1.0
            } else {
                (PI * cutoff * offset).sin() / (PI * offset)
            };
            let window =
                0.42 + 0.5 * (PI * normalized).cos() + 0.08 * (2.0 * PI * normalized).cos();
            let value = cutoff * sinc * window;
            *slot = value as f32;
            sum += value;
        }
        if sum.abs() > 1e-12 {
            for slot in &mut kernel {
                *slot = (*slot as f64 / sum) as f32;
            }
        }
        kernels.push(kernel);
    }
    kernels
}

fn sanitize(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: u32, seconds: f64) -> Vec<f32> {
        let count = (rate as f64 * seconds) as usize;
        (0..count)
            .map(|n| (2.0 * PI * freq * n as f64 / rate as f64).sin() as f32)
            .collect()
    }

    fn rms(samples: &[f32]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        (samples.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    }

    #[test]
    fn downsamples_48k_to_16k_with_expected_length_and_level() {
        let input = sine(1_000.0, 48_000, 1.0);
        let output = resample_all(&input, 48_000, 16_000).unwrap();
        assert!(
            (output.len() as i64 - 16_000).abs() <= 24,
            "len={}",
            output.len()
        );
        let level = rms(&output[200..output.len() - 200]);
        assert!((level - 0.707).abs() < 0.03, "rms={level}");
    }

    #[test]
    fn upsamples_44k1_to_48k_with_expected_length() {
        let input = sine(440.0, 44_100, 1.0);
        let output = resample_all(&input, 44_100, 48_000).unwrap();
        assert!(
            (output.len() as i64 - 48_000).abs() <= 24,
            "len={}",
            output.len()
        );
        let level = rms(&output[400..output.len() - 400]);
        assert!((level - 0.707).abs() < 0.03, "rms={level}");
    }

    #[test]
    fn preserves_dc_level() {
        let input = vec![0.5f32; 4_800];
        let output = resample_all(&input, 48_000, 16_000).unwrap();
        let steady = &output[100..output.len() - 100];
        assert!(steady.iter().all(|sample| (*sample - 0.5).abs() < 1e-3));
    }

    #[test]
    fn rejects_impossible_configurations() {
        assert!(SincResampler::new(0, 48_000).is_err());
        assert!(SincResampler::with_quality(48_000, 16_000, 4, 64).is_err());
        assert!(SincResampler::with_quality(48_000, 16_000, 16, 64).is_err());
    }

    #[test]
    fn streaming_in_irregular_chunks_matches_single_shot() {
        let input = sine(1_000.0, 48_000, 0.25);
        let single = resample_all(&input, 48_000, 24_000).unwrap();

        let mut resampler = SincResampler::new(48_000, 24_000).unwrap();
        let mut streamed = Vec::new();
        for chunk in input.chunks(777) {
            resampler.process(chunk, &mut streamed);
        }
        resampler.finish(&mut streamed);
        assert_eq!(single.len(), streamed.len());
        let max_delta = single
            .iter()
            .zip(streamed.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max_delta < 1e-5, "max delta {max_delta}");
    }
}
