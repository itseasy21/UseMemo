//! Peak/RMS metering for the recording HUD and `audio:levels` events.

use serde::{Deserialize, Serialize};

pub const DBFS_FLOOR: f32 = -120.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelFrame {
    pub rms_dbfs: f32,
    pub peak_dbfs: f32,
    pub rms: f32,
    pub peak: f32,
}

impl LevelFrame {
    pub fn silence() -> Self {
        Self {
            rms_dbfs: DBFS_FLOOR,
            peak_dbfs: DBFS_FLOOR,
            rms: 0.0,
            peak: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LevelMeter {
    attack: f32,
    release: f32,
    rms_dbfs: f32,
    peak_dbfs: f32,
}

impl Default for LevelMeter {
    fn default() -> Self {
        Self::new()
    }
}

impl LevelMeter {
    pub fn new() -> Self {
        Self {
            attack: 0.65,
            release: 0.15,
            rms_dbfs: DBFS_FLOOR,
            peak_dbfs: DBFS_FLOOR,
        }
    }

    /// Smooth one block of samples. Attack is fast so speech onsets are
    /// visible; release is slower so the meter does not flicker.
    pub fn process(&mut self, samples: &[f32]) -> LevelFrame {
        let (rms, peak) = block_levels(samples);
        let rms_dbfs = amplitude_to_dbfs(rms);
        let peak_dbfs = amplitude_to_dbfs(peak);

        // Snap the first non-silent block so the HUD does not animate up
        // from the floor after every reset.
        self.rms_dbfs = if self.rms_dbfs <= DBFS_FLOOR {
            rms_dbfs
        } else {
            smooth(self.rms_dbfs, rms_dbfs, self.attack, self.release)
        };
        self.peak_dbfs = if self.peak_dbfs <= DBFS_FLOOR {
            peak_dbfs
        } else {
            smooth(self.peak_dbfs, peak_dbfs, self.attack, self.release)
        };
        LevelFrame {
            rms_dbfs: self.rms_dbfs,
            peak_dbfs: self.peak_dbfs,
            rms: dbfs_to_amplitude(self.rms_dbfs),
            peak: dbfs_to_amplitude(self.peak_dbfs),
        }
    }

    pub fn reset(&mut self) {
        self.rms_dbfs = DBFS_FLOOR;
        self.peak_dbfs = DBFS_FLOOR;
    }
}

pub fn block_levels(samples: &[f32]) -> (f32, f32) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum_squares = 0.0f64;
    let mut peak = 0.0f32;
    for &sample in samples {
        let value = if sample.is_finite() { sample } else { 0.0 };
        sum_squares += (value as f64) * (value as f64);
        peak = peak.max(value.abs());
    }
    let rms = (sum_squares / samples.len() as f64).sqrt() as f32;
    (rms, peak.min(1.0))
}

pub fn amplitude_to_dbfs(amplitude: f32) -> f32 {
    if amplitude <= 1e-7 {
        DBFS_FLOOR
    } else {
        (20.0 * amplitude.log10()).max(DBFS_FLOOR)
    }
}

pub fn dbfs_to_amplitude(dbfs: f32) -> f32 {
    if dbfs <= DBFS_FLOOR {
        0.0
    } else {
        10f32.powf(dbfs / 20.0)
    }
}

fn smooth(current: f32, next: f32, attack: f32, release: f32) -> f32 {
    let coefficient = if next > current { attack } else { release };
    current + (next - current) * coefficient
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_sits_on_the_floor() {
        let frame = LevelMeter::new().process(&[0.0; 480]);
        assert_eq!(frame.rms_dbfs, DBFS_FLOOR);
        assert_eq!(frame.peak_dbfs, DBFS_FLOOR);
        assert_eq!(frame.rms, 0.0);
    }

    #[test]
    fn full_scale_square_wave_reads_zero_dbfs() {
        let frame = LevelMeter::new().process(&[1.0, -1.0, 1.0, -1.0]);
        assert!((frame.rms_dbfs - 0.0).abs() < 0.01);
        assert!((frame.peak_dbfs - 0.0).abs() < 0.01);
    }

    #[test]
    fn half_scale_tone_is_about_minus_six_db() {
        let samples: Vec<f32> = (0..4_800)
            .map(|n| 0.5 * (2.0 * std::f32::consts::PI * 1_000.0 * n as f32 / 48_000.0).sin())
            .collect();
        let frame = LevelMeter::new().process(&samples);
        assert!(
            (frame.rms_dbfs - (-9.03)).abs() < 0.2,
            "rms={}",
            frame.rms_dbfs
        );
        assert!(
            (frame.peak_dbfs - (-6.02)).abs() < 0.2,
            "peak={}",
            frame.peak_dbfs
        );
    }

    #[test]
    fn meter_releases_gradually() {
        let mut meter = LevelMeter::new();
        meter.process(&[1.0; 480]);
        let after = meter.process(&[0.0; 480]);
        assert!(after.rms_dbfs < 0.0);
        assert!(after.rms_dbfs > DBFS_FLOOR);
    }

    #[test]
    fn non_finite_input_is_ignored() {
        let (rms, peak) = block_levels(&[f32::NAN, f32::INFINITY, -0.5]);
        assert!(rms.is_finite());
        assert!((peak - 0.5).abs() < 1e-6);
    }
}
