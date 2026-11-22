//! Meeting clock derived from mixed sample counts.
//!
//! Wall-clock time drifts when a device stalls; transcript and screenshot
//! timestamps must both reference the same monotonic audio timeline.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleClock {
    sample_rate: u32,
    samples: u64,
}

impl SampleClock {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate: sample_rate.max(1),
            samples: 0,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn samples(&self) -> u64 {
        self.samples
    }

    pub fn advance(&mut self, frames: usize) {
        self.samples = self.samples.saturating_add(frames as u64);
    }

    pub fn elapsed_ms(&self) -> i64 {
        (self.samples as u128 * 1_000 / self.sample_rate as u128) as i64
    }

    pub fn elapsed_secs(&self) -> f64 {
        self.samples as f64 / self.sample_rate as f64
    }

    pub fn timestamp(&self) -> String {
        format_timestamp(self.elapsed_ms())
    }

    pub fn reset(&mut self) {
        self.samples = 0;
    }
}

/// `[T-MM:SS]` component used by the evidence index.
pub fn format_timestamp(ms: i64) -> String {
    let total_seconds = (ms.max(0) / 1_000) as u64;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes:02}:{seconds:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advances_at_48k() {
        let mut clock = SampleClock::new(48_000);
        clock.advance(48_000);
        assert_eq!(clock.elapsed_ms(), 1_000);
        assert_eq!(clock.timestamp(), "00:01");
        clock.advance(48_000 * 90);
        assert_eq!(clock.timestamp(), "01:31");
    }

    #[test]
    fn formats_hours_as_minutes_for_evidence() {
        assert_eq!(format_timestamp(3_723_000), "62:03");
        assert_eq!(format_timestamp(-5), "00:00");
    }

    #[test]
    fn reset_returns_to_zero() {
        let mut clock = SampleClock::new(16_000);
        clock.advance(32_000);
        clock.reset();
        assert_eq!(clock.elapsed_ms(), 0);
    }
}
