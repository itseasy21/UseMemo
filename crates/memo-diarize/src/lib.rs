//! On-device speaker diarization.
//!
//! The pipeline is intentionally small and deterministic:
//!
//! 1. energy-based VAD finds speech regions;
//! 2. sliding windows are embedded with MFCC mean/std statistics;
//! 3. deterministic k-means chooses the smallest defensible speaker count;
//! 4. stable turns are emitted for transcript alignment.
//!
//! No model download and no network access are involved. The trade-off is
//! honest: this is acoustic clustering for a handful of voices in a meeting,
//! not voice identification. Short or overlapping speech can fall back to a
//! channel label.

mod cluster;
mod features;
mod vad;

use cluster::{cluster, ClusterConfig};
use features::{extract, FrameFeatures, HOP_MS, MFCC_COUNT};
use vad::{speech_regions, VadConfig};

pub use cluster::Clustering;
pub use vad::SpeechRegion;

pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Debug, Clone)]
pub struct DiarizationConfig {
    pub window_ms: u32,
    pub hop_ms: u32,
    pub min_speech_ms: u32,
    pub min_window_speech_ms: u32,
    pub max_speakers: usize,
    pub min_separation: f32,
    pub min_cluster_ms: u32,
    pub max_transition_rate: f32,
    pub merge_gap_ms: u32,
}

impl Default for DiarizationConfig {
    fn default() -> Self {
        Self {
            window_ms: 1_500,
            hop_ms: 750,
            min_speech_ms: 1_000,
            min_window_speech_ms: 600,
            max_speakers: 6,
            min_separation: 2.2,
            min_cluster_ms: 4_000,
            max_transition_rate: 0.6,
            merge_gap_ms: 350,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeakerTurn {
    pub start_ms: i64,
    pub end_ms: i64,
    /// One-based speaker number. Never zero.
    pub speaker: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diarization {
    pub turns: Vec<SpeakerTurn>,
    /// Number of distinct speakers detected. `1` means the archive was not
    /// separable, so callers should keep their channel label.
    pub speakers: usize,
    /// Total speech covered by the VAD, in milliseconds.
    pub speech_ms: i64,
    /// Number of embedding windows that contributed to the result.
    pub windows: usize,
}

impl Diarization {
    pub fn is_empty(&self) -> bool {
        self.turns.is_empty()
    }
}

struct Window {
    region: usize,
    start_ms: i64,
    end_ms: i64,
    embedding: Vec<f32>,
}

pub fn diarize(samples: &[f32], config: &DiarizationConfig) -> Diarization {
    if samples.is_empty() {
        return empty();
    }

    let features = extract(samples);
    if features.is_empty() {
        return empty();
    }

    let vad_config = VadConfig {
        merge_gap_ms: config.merge_gap_ms,
        min_speech_ms: config.min_speech_ms,
    };
    let regions = speech_regions(&features.energy_db, HOP_MS, features::FRAME_MS, &vad_config);
    if regions.is_empty() {
        return empty();
    }
    let speech_ms = regions
        .iter()
        .map(|region| region.duration_ms(HOP_MS, features::FRAME_MS) as i64)
        .sum();

    let windows = windows_for(&features, &regions, config);
    if windows.is_empty() {
        return Diarization {
            turns: Vec::new(),
            speakers: 0,
            speech_ms,
            windows: 0,
        };
    }
    let window_count = windows.len();

    if windows.len() < 3 {
        let turns = windows
            .iter()
            .map(|window| SpeakerTurn {
                start_ms: window.start_ms,
                end_ms: window.end_ms,
                speaker: 1,
            })
            .collect();
        return Diarization {
            turns,
            speakers: 1,
            speech_ms,
            windows: window_count,
        };
    }

    let embeddings: Vec<Vec<f32>> = windows
        .iter()
        .map(|window| window.embedding.clone())
        .collect();
    let durations: Vec<u32> = windows
        .iter()
        .map(|window| (window.end_ms - window.start_ms).max(0) as u32)
        .collect();
    let clustering = cluster(
        &embeddings,
        &durations,
        &ClusterConfig {
            max_speakers: config.max_speakers,
            min_separation: config.min_separation,
            min_cluster_ms: config.min_cluster_ms,
            max_transition_rate: config.max_transition_rate,
            ..ClusterConfig::default()
        },
    );

    let assignments = smooth(&windows, &clustering.assignments);
    let turns = build_turns(&windows, &assignments);
    let speakers = turns.iter().map(|turn| turn.speaker).max().unwrap_or(0);
    Diarization {
        turns,
        speakers,
        speech_ms,
        windows: window_count,
    }
}

/// Pick the turn with the largest overlap; if the segment falls in a short gap,
/// use the nearest turn within 750 ms so a transcript line is not orphaned.
pub fn speaker_at(turns: &[SpeakerTurn], start_ms: i64, end_ms: i64) -> Option<usize> {
    let end_ms = end_ms.max(start_ms);
    let mut best: Option<(i64, usize)> = None;
    for turn in turns {
        let overlap = end_ms.min(turn.end_ms) - start_ms.max(turn.start_ms);
        if overlap > 0 && best.map(|(score, _)| overlap > score).unwrap_or(true) {
            best = Some((overlap, turn.speaker));
        }
    }
    if let Some((_, speaker)) = best {
        return Some(speaker);
    }

    let mut nearest: Option<(i64, usize)> = None;
    for turn in turns {
        let distance = if turn.end_ms <= start_ms {
            start_ms - turn.end_ms
        } else {
            turn.start_ms - end_ms
        };
        if distance <= 750 && nearest.map(|(best, _)| distance < best).unwrap_or(true) {
            nearest = Some((distance, turn.speaker));
        }
    }
    nearest.map(|(_, speaker)| speaker)
}

fn empty() -> Diarization {
    Diarization {
        turns: Vec::new(),
        speakers: 0,
        speech_ms: 0,
        windows: 0,
    }
}

fn windows_for(
    features: &FrameFeatures,
    regions: &[SpeechRegion],
    config: &DiarizationConfig,
) -> Vec<Window> {
    let mut windows = Vec::new();
    let min_frames = (config.min_window_speech_ms / HOP_MS).max(1) as usize;

    for (region_index, region) in regions.iter().enumerate() {
        let region_start = region.start_ms(HOP_MS);
        let region_end = region.end_ms(HOP_MS, features::FRAME_MS);
        if region_end - region_start < config.min_window_speech_ms as i64 {
            continue;
        }

        let mut starts = Vec::new();
        if region_end - region_start <= config.window_ms as i64 {
            starts.push(region_start);
        } else {
            let mut start = region_start;
            while start + config.window_ms as i64 <= region_end {
                starts.push(start);
                start += config.hop_ms as i64;
            }
            let tail = region_end - config.window_ms as i64;
            if starts
                .last()
                .map(|last| tail - *last >= config.hop_ms as i64 / 2)
                .unwrap_or(true)
            {
                starts.push(tail);
            }
        }

        for start in starts {
            let end = (start + config.window_ms as i64).min(region_end);
            if end - start < config.min_window_speech_ms as i64 {
                continue;
            }
            let first = (start / HOP_MS as i64).max(0) as usize;
            let last = ((end + HOP_MS as i64 - 1) / HOP_MS as i64) as usize;
            let last = last.min(features.len());
            if last <= first || last - first < min_frames {
                continue;
            }
            let embedding = embed(features, first, last);
            windows.push(Window {
                region: region_index,
                start_ms: start,
                end_ms: end,
                embedding,
            });
        }
    }

    windows
}

fn embed(features: &FrameFeatures, first: usize, last: usize) -> Vec<f32> {
    let count = (last - first) as f32;
    let mut mean = [0.0f32; MFCC_COUNT];
    for frame in first..last {
        for (coefficient, value) in features.mfcc(frame).iter().enumerate() {
            mean[coefficient] += value;
        }
    }
    for value in &mut mean {
        *value /= count;
    }

    let mut variance = [0.0f32; MFCC_COUNT];
    let mut delta_mean = [0.0f32; MFCC_COUNT];
    let mut delta_variance = [0.0f32; MFCC_COUNT];
    for frame in first..last {
        let current = features.mfcc(frame);
        let previous = features.mfcc(frame.saturating_sub(1));
        let next = features.mfcc((frame + 1).min(features.len() - 1));
        for coefficient in 0..MFCC_COUNT {
            let delta = (next[coefficient] - previous[coefficient]) * 0.5;
            variance[coefficient] += (current[coefficient] - mean[coefficient]).powi(2);
            delta_mean[coefficient] += delta;
            delta_variance[coefficient] += delta * delta;
        }
    }
    for coefficient in 0..MFCC_COUNT {
        variance[coefficient] = (variance[coefficient] / count).sqrt();
        delta_mean[coefficient] /= count;
        delta_variance[coefficient] = (delta_variance[coefficient] / count
            - delta_mean[coefficient].powi(2))
        .max(0.0)
        .sqrt();
    }

    let mut embedding = Vec::with_capacity(MFCC_COUNT * 4);
    embedding.extend_from_slice(&mean);
    embedding.extend_from_slice(&variance);
    embedding.extend_from_slice(&delta_mean);
    embedding.extend_from_slice(&delta_variance);
    embedding
}

/// Majority vote over neighbouring windows from the same speech region. A
/// window separated by a real pause is left alone.
fn smooth(windows: &[Window], assignments: &[usize]) -> Vec<usize> {
    let mut output = assignments.to_vec();
    for index in 0..windows.len() {
        let current = assignments[index];
        let mut votes = [0usize; 8];
        votes[current.min(7)] += 1;
        for neighbour in [index.wrapping_sub(1), index + 1] {
            if neighbour >= windows.len() || neighbour == index {
                continue;
            }
            if windows[neighbour].region == windows[index].region {
                votes[assignments[neighbour].min(7)] += 1;
            }
        }
        let best = (0..8)
            .max_by_key(|speaker| votes[*speaker])
            .unwrap_or(current);
        if votes[best] > votes[current.min(7)] {
            output[index] = best;
        }
    }
    output
}

fn build_turns(windows: &[Window], assignments: &[usize]) -> Vec<SpeakerTurn> {
    let mut turns: Vec<SpeakerTurn> = Vec::new();
    let mut index = 0usize;
    while index < windows.len() {
        let region = windows[index].region;
        let mut end = index + 1;
        while end < windows.len() && windows[end].region == region {
            end += 1;
        }
        let group = &windows[index..end];
        let group_assignments = &assignments[index..end];
        let centers: Vec<i64> = group
            .iter()
            .map(|window| (window.start_ms + window.end_ms) / 2)
            .collect();

        for (position, window) in group.iter().enumerate() {
            let start = if position == 0 {
                window.start_ms
            } else {
                (centers[position - 1] + centers[position]) / 2
            };
            let end = if position + 1 == group.len() {
                window.end_ms
            } else {
                (centers[position] + centers[position + 1]) / 2
            };
            let speaker = group_assignments[position] + 1;
            if let Some(last) = turns.last_mut() {
                if last.speaker == speaker && start <= last.end_ms + 50 {
                    last.end_ms = last.end_ms.max(end);
                    continue;
                }
            }
            turns.push(SpeakerTurn {
                start_ms: start,
                end_ms: end,
                speaker,
            });
        }
        index = end;
    }

    // Relabel by first appearance so the transcript reads Speaker 1, 2, ...
    let mut seen: Vec<usize> = Vec::new();
    for turn in &mut turns {
        let position = match seen.iter().position(|speaker| *speaker == turn.speaker) {
            Some(position) => position,
            None => {
                seen.push(turn.speaker);
                seen.len() - 1
            }
        };
        turn.speaker = position + 1;
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const RATE: f32 = 16_000.0;

    fn voice(fundamental: f32, seconds: f32, harmonics: &[f32]) -> Vec<f32> {
        let count = (seconds * RATE) as usize;
        let fade = (0.02 * RATE) as usize;
        (0..count)
            .map(|index| {
                let time = index as f32 / RATE;
                let mut value = 0.0;
                for (harmonic, amplitude) in harmonics.iter().enumerate() {
                    value +=
                        amplitude * (2.0 * PI * fundamental * (harmonic + 1) as f32 * time).sin();
                }
                let envelope = if index < fade {
                    index as f32 / fade as f32
                } else if index + fade >= count {
                    (count - index) as f32 / fade as f32
                } else {
                    1.0
                };
                value * 0.12 * envelope
            })
            .collect()
    }

    fn silence(seconds: f32) -> Vec<f32> {
        vec![0.0; (seconds * RATE) as usize]
    }

    fn concat(parts: &[Vec<f32>]) -> Vec<f32> {
        parts.iter().flatten().copied().collect()
    }

    fn two_speakers() -> Vec<f32> {
        let first = voice(118.0, 4.0, &[1.0, 0.62, 0.24, 0.09, 0.04]);
        let second = voice(212.0, 4.0, &[0.55, 1.0, 0.5, 0.22, 0.14]);
        let mut parts = Vec::new();
        for _ in 0..3 {
            parts.push(first.clone());
            parts.push(silence(0.8));
            parts.push(second.clone());
            parts.push(silence(0.8));
        }
        concat(&parts)
    }

    #[test]
    fn two_alternating_timbres_are_separated() {
        let audio = two_speakers();
        let result = diarize(&audio, &DiarizationConfig::default());
        assert_eq!(result.speakers, 2, "turns: {:?}", result.turns);
        assert!(result.turns.len() >= 6, "turns: {:?}", result.turns);
        assert_eq!(result.turns[0].speaker, 1);
        assert_eq!(result.turns[1].speaker, 2);
        assert!(result.speech_ms > 20_000);
    }

    #[test]
    fn one_voice_stays_one_speaker_even_when_the_level_changes() {
        let quiet = voice(150.0, 5.0, &[1.0, 0.4, 0.15]);
        let loud: Vec<f32> = quiet.iter().map(|sample| sample * 2.5).collect();
        let audio = concat(&[
            quiet.clone(),
            silence(0.8),
            loud.clone(),
            silence(0.8),
            quiet,
            silence(0.8),
            loud,
        ]);
        let result = diarize(&audio, &DiarizationConfig::default());
        assert_eq!(result.speakers, 1, "turns: {:?}", result.turns);
    }

    #[test]
    fn silence_has_no_turns() {
        let result = diarize(&silence(10.0), &DiarizationConfig::default());
        assert!(result.turns.is_empty());
        assert_eq!(result.speakers, 0);
    }

    #[test]
    fn short_audio_does_not_panic() {
        let result = diarize(&[0.0; 100], &DiarizationConfig::default());
        assert!(result.turns.is_empty());
    }

    #[test]
    fn speaker_at_prefers_overlap_then_nearby_turns() {
        let turns = vec![
            SpeakerTurn {
                start_ms: 0,
                end_ms: 1_000,
                speaker: 1,
            },
            SpeakerTurn {
                start_ms: 1_000,
                end_ms: 2_000,
                speaker: 2,
            },
        ];
        assert_eq!(speaker_at(&turns, 900, 1_400), Some(2));
        assert_eq!(speaker_at(&turns, 2_500, 2_700), Some(2));
        assert_eq!(speaker_at(&turns, 4_000, 4_500), None);
    }
}
