//! Conservative energy-based voice activity detection.
//!
//! Diarization only needs speech *regions*, not phoneme accuracy. A percentile
//! noise floor plus hysteresis avoids splitting on breaths and room tone, and
//! the merge/short-region rules keep the embedding windows long enough to be
//! useful.

pub struct VadConfig {
    /// Join speech regions separated by a pause shorter than this.
    pub merge_gap_ms: u32,
    /// Discard regions shorter than this; too short to embed reliably.
    pub min_speech_ms: u32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            merge_gap_ms: 350,
            min_speech_ms: 1_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeechRegion {
    /// First speech frame (inclusive).
    pub start_frame: usize,
    /// One past the last speech frame.
    pub end_frame: usize,
}

impl SpeechRegion {
    pub fn duration_ms(&self, hop_ms: u32, frame_ms: u32) -> u32 {
        if self.end_frame <= self.start_frame {
            return 0;
        }
        (self.end_frame - self.start_frame) as u32 * hop_ms + frame_ms
    }

    pub fn start_ms(&self, hop_ms: u32) -> i64 {
        self.start_frame as i64 * hop_ms as i64
    }

    pub fn end_ms(&self, hop_ms: u32, frame_ms: u32) -> i64 {
        if self.end_frame == 0 {
            return 0;
        }
        (self.end_frame - 1) as i64 * hop_ms as i64 + frame_ms as i64
    }
}

pub fn speech_regions(
    energy_db: &[f32],
    hop_ms: u32,
    frame_ms: u32,
    config: &VadConfig,
) -> Vec<SpeechRegion> {
    if energy_db.is_empty() {
        return Vec::new();
    }

    let noise_floor = percentile(energy_db, 0.10);
    let high = (noise_floor + 9.0).clamp(-55.0, -25.0);
    let low = (high - 6.0).max(-60.0);
    let onset_frames = (30 / hop_ms).max(1) as usize;
    let hangover_frames = (250 / hop_ms).max(1) as usize;

    let mut mask = vec![false; energy_db.len()];
    let mut active = false;
    let mut above = 0usize;
    let mut below = 0usize;
    let mut last_speech = 0usize;

    for (index, db) in energy_db.iter().copied().enumerate() {
        if !active {
            if db > high {
                above += 1;
                if above >= onset_frames {
                    active = true;
                    below = 0;
                    last_speech = index;
                    let start = index + 1 - above;
                    mask[start..=index].fill(true);
                }
            } else {
                above = 0;
            }
            continue;
        }

        if db > low {
            mask[index] = true;
            last_speech = index;
            below = 0;
        } else {
            below += 1;
            if below >= hangover_frames {
                active = false;
                above = 0;
                mask[(last_speech + 1)..index].fill(false);
            }
        }
    }

    let mut regions: Vec<SpeechRegion> = Vec::new();
    let mut cursor = 0usize;
    while cursor < mask.len() {
        if !mask[cursor] {
            cursor += 1;
            continue;
        }
        let start = cursor;
        while cursor < mask.len() && mask[cursor] {
            cursor += 1;
        }
        push_region(
            &mut regions,
            SpeechRegion {
                start_frame: start,
                end_frame: cursor,
            },
            hop_ms,
            config,
        );
    }

    // Apply the duration floor after merging. A quieter speaker can arrive as
    // several sub-second runs separated by breaths; dropping each run before
    // the merge rule would erase that speaker entirely.
    regions.retain(|region| region.duration_ms(hop_ms, frame_ms) >= config.min_speech_ms);
    regions
}

fn push_region(
    regions: &mut Vec<SpeechRegion>,
    region: SpeechRegion,
    hop_ms: u32,
    config: &VadConfig,
) {
    if let Some(previous) = regions.last_mut() {
        let gap_ms = (region.start_frame - previous.end_frame) as u32 * hop_ms;
        if gap_ms <= config.merge_gap_ms {
            previous.end_frame = region.end_frame;
            return;
        }
    }
    regions.push(region);
}

fn percentile(values: &[f32], fraction: f32) -> f32 {
    let mut sorted: Vec<f32> = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect();
    if sorted.is_empty() {
        return -120.0;
    }
    sorted.sort_by(f32::total_cmp);
    let index = ((sorted.len() - 1) as f32 * fraction.clamp(0.0, 1.0)).round() as usize;
    sorted[index]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(levels: &[(f32, usize)]) -> Vec<f32> {
        let mut output = Vec::new();
        for (db, count) in levels {
            output.extend(std::iter::repeat_n(*db, *count));
        }
        output
    }

    #[test]
    fn two_bursts_become_two_regions() {
        let energy = frames(&[
            (-80.0, 50),
            (-20.0, 100),
            (-80.0, 100),
            (-22.0, 100),
            (-80.0, 50),
        ]);
        let regions = speech_regions(&energy, 10, 25, &VadConfig::default());
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].start_frame, 50);
        assert_eq!(regions[1].start_frame, 250);
    }

    #[test]
    fn short_clicks_are_dropped() {
        let energy = frames(&[(-80.0, 50), (-20.0, 20), (-80.0, 50)]);
        let regions = speech_regions(&energy, 10, 25, &VadConfig::default());
        assert!(regions.is_empty());
    }

    #[test]
    fn fragments_merge_before_the_duration_floor() {
        // Two 625 ms runs separated by a 300 ms pause are each too short to
        // embed, but together they clear the one-second floor.
        let energy = frames(&[(-20.0, 60), (-70.0, 30), (-20.0, 60)]);
        let regions = speech_regions(&energy, 10, 25, &VadConfig::default());
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].start_frame, 0);
        assert_eq!(regions[0].end_frame, 150);
    }

    #[test]
    fn a_short_pause_merges_the_region() {
        let energy = frames(&[(-20.0, 100), (-80.0, 10), (-20.0, 100)]);
        let regions = speech_regions(&energy, 10, 25, &VadConfig::default());
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].end_frame, 210);
    }

    #[test]
    fn constant_loud_audio_is_not_automatically_speech() {
        let energy = vec![-20.0; 200];
        let regions = speech_regions(&energy, 10, 25, &VadConfig::default());
        assert_eq!(regions.len(), 1);
    }
}
