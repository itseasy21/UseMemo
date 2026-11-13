//! Bounded sample ring used between real-time capture callbacks and the mixer.
//!
//! The capture callback must never block on a slow consumer. When the ring is
//! full, the oldest samples are discarded so the mixer always works on the most
//! recent audio. `dropped()` exposes that overrun for diagnostics.

use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct SampleRing {
    samples: VecDeque<f32>,
    capacity: usize,
    dropped: u64,
}

impl SampleRing {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "ring capacity must be positive");
        Self {
            samples: VecDeque::with_capacity(capacity),
            capacity,
            dropped: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn clear(&mut self) {
        self.samples.clear();
        self.dropped = 0;
    }

    /// Push one sample. Returns `true` when an older sample had to be dropped.
    pub fn push(&mut self, sample: f32) -> bool {
        let mut dropped = false;
        while self.samples.len() >= self.capacity {
            self.samples.pop_front();
            self.dropped += 1;
            dropped = true;
        }
        self.samples.push_back(sanitize(sample));
        dropped
    }

    /// Push a slice and return the number of oldest samples evicted.
    pub fn push_slice(&mut self, samples: &[f32]) -> usize {
        if samples.is_empty() {
            return 0;
        }
        let mut evicted = 0;
        for &sample in samples {
            if self.samples.len() >= self.capacity {
                self.samples.pop_front();
                evicted += 1;
            }
            self.samples.push_back(sanitize(sample));
        }
        self.dropped += evicted as u64;
        evicted
    }

    /// Copy up to `out.len()` samples out of the ring. Returns the copied count.
    pub fn pop_into(&mut self, out: &mut [f32]) -> usize {
        let count = out.len().min(self.samples.len());
        for slot in out.iter_mut().take(count) {
            *slot = self.samples.pop_front().unwrap_or(0.0);
        }
        count
    }

    pub fn pop(&mut self) -> Option<f32> {
        self.samples.pop_front()
    }

    /// Discard the oldest `count` samples.
    pub fn skip(&mut self, count: usize) {
        let count = count.min(self.samples.len());
        self.samples.drain(..count);
    }
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

    #[test]
    fn keeps_order_and_reports_available_samples() {
        let mut ring = SampleRing::new(4);
        assert_eq!(ring.push_slice(&[0.1, 0.2, 0.3]), 0);
        assert_eq!(ring.len(), 3);
        let mut out = [0.0; 2];
        assert_eq!(ring.pop_into(&mut out), 2);
        assert!((out[0] - 0.1).abs() < 1e-6);
        assert!((out[1] - 0.2).abs() < 1e-6);
        assert_eq!(ring.len(), 1);
    }

    #[test]
    fn overflow_evicts_oldest_samples() {
        let mut ring = SampleRing::new(3);
        assert_eq!(ring.push_slice(&[0.1, 0.2, 0.3, 0.4, 0.5]), 2);
        assert_eq!(ring.dropped(), 2);
        let mut out = [0.0; 3];
        assert_eq!(ring.pop_into(&mut out), 3);
        assert_eq!(out, [0.3, 0.4, 0.5]);
    }

    #[test]
    fn non_finite_samples_are_silenced() {
        let mut ring = SampleRing::new(2);
        ring.push(f32::NAN);
        ring.push(f32::INFINITY);
        let mut out = [9.0; 2];
        ring.pop_into(&mut out);
        assert_eq!(out, [0.0, 0.0]);
    }
}
