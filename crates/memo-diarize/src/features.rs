//! Frame-level acoustic features: energy, log-mel spectrum, and MFCCs.
//!
//! Everything here is dependency-free on purpose. A 512-point radix-2 FFT is
//! enough for 25 ms frames at 16 kHz, and a hand-written mel filterbank keeps
//! the crate portable to every desktop and mobile target without an ONNX or
//! linear-algebra runtime.

use std::f32::consts::PI;

pub const FRAME_LEN: usize = 400; // 25 ms at 16 kHz
pub const FRAME_MS: u32 = 25;
pub const HOP_LEN: usize = 160; // 10 ms at 16 kHz
pub const HOP_MS: u32 = 10;
pub const FFT_SIZE: usize = 512;
pub const MEL_BANDS: usize = 26;
pub const MFCC_COUNT: usize = 20;

/// Per-frame features for one archive. MFCCs are stored flat (frame-major) to
/// avoid one heap allocation per 10 ms frame.
pub struct FrameFeatures {
    pub energy_db: Vec<f32>,
    mfcc: Vec<f32>,
}

impl FrameFeatures {
    pub fn len(&self) -> usize {
        self.energy_db.len()
    }

    pub fn is_empty(&self) -> bool {
        self.energy_db.is_empty()
    }

    pub fn mfcc(&self, frame: usize) -> &[f32] {
        let start = frame * MFCC_COUNT;
        &self.mfcc[start..start + MFCC_COUNT]
    }
}

pub fn extract(samples: &[f32]) -> FrameFeatures {
    if samples.len() < FRAME_LEN {
        return FrameFeatures {
            energy_db: Vec::new(),
            mfcc: Vec::new(),
        };
    }

    let frame_count = 1 + (samples.len() - FRAME_LEN) / HOP_LEN;
    let window = hann_window(FRAME_LEN);
    let mel = MelBank::new(16_000, FFT_SIZE, MEL_BANDS);
    let dct = dct_table(MEL_BANDS, MFCC_COUNT);
    let mut planner = Fft::new(FFT_SIZE);

    let mut energy_db = Vec::with_capacity(frame_count);
    let mut mfcc = Vec::with_capacity(frame_count * MFCC_COUNT);
    let mut re = vec![0.0f32; FFT_SIZE];
    let mut im = vec![0.0f32; FFT_SIZE];
    let mut spectrum = vec![0.0f32; FFT_SIZE / 2 + 1];

    for frame in 0..frame_count {
        let offset = frame * HOP_LEN;
        let raw = &samples[offset..offset + FRAME_LEN];
        let mean_square = raw.iter().map(|sample| sample * sample).sum::<f32>() / FRAME_LEN as f32;
        energy_db.push(10.0 * (mean_square + 1e-12).log10());

        re.fill(0.0);
        im.fill(0.0);
        for (index, sample) in raw.iter().enumerate() {
            re[index] = sample * window[index];
        }
        planner.forward(&mut re, &mut im);
        for (bin, power) in spectrum.iter_mut().enumerate() {
            *power = re[bin] * re[bin] + im[bin] * im[bin];
        }

        let mut log_mel = [0.0f32; MEL_BANDS];
        for (band, output) in log_mel.iter_mut().enumerate() {
            let energy: f32 = mel.bands[band]
                .iter()
                .map(|(bin, weight)| spectrum[*bin] * weight)
                .sum();
            *output = (energy + 1e-10).ln();
        }
        for row in dct.iter().take(MFCC_COUNT) {
            let value: f32 = (0..MEL_BANDS).map(|band| log_mel[band] * row[band]).sum();
            mfcc.push(value);
        }
    }

    FrameFeatures { energy_db, mfcc }
}

fn hann_window(length: usize) -> Vec<f32> {
    (0..length)
        .map(|index| 0.5 - 0.5 * (2.0 * PI * index as f32 / (length - 1) as f32).cos())
        .collect()
}

/// In-place iterative radix-2 Cooley-Tukey FFT. `re` and `im` must have the same
/// power-of-two length; this crate only ever asks for 512 points.
struct Fft {
    size: usize,
    reverse: Vec<usize>,
    cos: Vec<f32>,
    sin: Vec<f32>,
}

impl Fft {
    fn new(size: usize) -> Self {
        assert!(size.is_power_of_two(), "FFT size must be a power of two");
        let bits = size.trailing_zeros();
        let reverse = (0..size)
            .map(|index| index.reverse_bits() >> (usize::BITS - bits))
            .collect();
        let cos = (0..size / 2)
            .map(|index| (2.0 * PI * index as f32 / size as f32).cos())
            .collect();
        let sin = (0..size / 2)
            .map(|index| (-2.0 * PI * index as f32 / size as f32).sin())
            .collect();
        Self {
            size,
            reverse,
            cos,
            sin,
        }
    }

    fn forward(&mut self, re: &mut [f32], im: &mut [f32]) {
        debug_assert_eq!(re.len(), self.size);
        debug_assert_eq!(im.len(), self.size);

        for (index, target) in self.reverse.iter().copied().enumerate() {
            if index < target {
                re.swap(index, target);
                im.swap(index, target);
            }
        }

        let mut length = 2;
        while length <= self.size {
            let half = length / 2;
            let step = self.size / length;
            for start in (0..self.size).step_by(length) {
                for offset in 0..half {
                    let twiddle = offset * step;
                    let wr = self.cos[twiddle];
                    let wi = self.sin[twiddle];
                    let even = start + offset;
                    let odd = even + half;
                    let odd_re = re[odd] * wr - im[odd] * wi;
                    let odd_im = re[odd] * wi + im[odd] * wr;
                    let even_re = re[even];
                    let even_im = im[even];
                    re[even] = even_re + odd_re;
                    im[even] = even_im + odd_im;
                    re[odd] = even_re - odd_re;
                    im[odd] = even_im - odd_im;
                }
            }
            length <<= 1;
        }
    }
}

struct MelBank {
    bands: Vec<Vec<(usize, f32)>>,
}

impl MelBank {
    fn new(sample_rate: u32, fft_size: usize, bands: usize) -> Self {
        let max_hz = sample_rate as f32 / 2.0;
        let low = hz_to_mel(0.0);
        let high = hz_to_mel(max_hz);
        let points: Vec<f32> = (0..bands + 2)
            .map(|index| {
                let mel = low + (high - low) * index as f32 / (bands + 1) as f32;
                mel_to_hz(mel)
            })
            .collect();
        let bins: Vec<usize> = points
            .iter()
            .map(|hz| ((fft_size as f32 + 1.0) * hz / sample_rate as f32) as usize)
            .map(|bin| bin.min(fft_size / 2))
            .collect();

        let mut output = Vec::with_capacity(bands);
        for band in 0..bands {
            let left = bins[band];
            let center = bins[band + 1];
            let right = bins[band + 2];
            let mut weights = Vec::new();
            for bin in left..=right {
                let weight = if bin <= center {
                    if center == left {
                        1.0
                    } else {
                        (bin - left) as f32 / (center - left) as f32
                    }
                } else if right == center {
                    1.0
                } else {
                    (right - bin) as f32 / (right - center) as f32
                };
                if weight > 0.0 {
                    weights.push((bin, weight));
                }
            }
            if weights.is_empty() {
                weights.push((center.min(fft_size / 2), 1.0));
            }
            output.push(weights);
        }
        Self { bands: output }
    }
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10.0f32.powf(mel / 2595.0) - 1.0)
}

fn dct_table(bands: usize, coefficients: usize) -> Vec<[f32; MEL_BANDS]> {
    let scale = (2.0 / bands as f32).sqrt();
    (0..coefficients)
        .map(|coefficient| {
            let mut row = [0.0f32; MEL_BANDS];
            for (band, value) in row.iter_mut().enumerate().take(bands) {
                let angle = PI * coefficient as f32 * (band as f32 + 0.5) / bands as f32;
                *value = scale * angle.cos();
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_finds_a_bin_centered_sine() {
        let mut re = vec![0.0f32; FFT_SIZE];
        let mut im = vec![0.0f32; FFT_SIZE];
        let bin = 32;
        for (index, sample) in re.iter_mut().enumerate() {
            *sample = (2.0 * PI * bin as f32 * index as f32 / FFT_SIZE as f32).sin();
        }
        Fft::new(FFT_SIZE).forward(&mut re, &mut im);
        let magnitudes: Vec<f32> = (0..FFT_SIZE / 2)
            .map(|index| re[index] * re[index] + im[index] * im[index])
            .collect();
        let peak = magnitudes
            .iter()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(right.1))
            .map(|(index, _)| index)
            .unwrap();
        assert_eq!(peak, bin);
    }

    #[test]
    fn silence_has_a_very_low_energy_floor() {
        let features = extract(&vec![0.0; 16_000]);
        assert!(features.len() > 90);
        assert!(features.energy_db.iter().all(|db| *db < -100.0));
    }

    #[test]
    fn a_tone_produces_finite_mfccs() {
        let samples: Vec<f32> = (0..16_000)
            .map(|index| (2.0 * PI * 220.0 * index as f32 / 16_000.0).sin() * 0.2)
            .collect();
        let features = extract(&samples);
        assert!(features.len() > 90);
        for coefficient in features.mfcc(10) {
            assert!(coefficient.is_finite());
        }
        assert!(features.energy_db[10] > -30.0);
    }

    #[test]
    fn short_audio_has_no_frames() {
        assert!(extract(&[0.0; 100]).is_empty());
    }
}
