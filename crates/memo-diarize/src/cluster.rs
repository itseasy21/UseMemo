//! Deterministic speaker clustering over acoustic embeddings.
//!
//! The number of speakers is chosen conservatively: k-means is evaluated for
//! every plausible k, and a split is accepted only when the smallest distance
//! between speaker centroids is clearly larger than the spread inside a
//! speaker. A transition-rate gate rejects unstable, content-driven splits.

pub struct ClusterConfig {
    pub max_speakers: usize,
    /// Minimum ratio between the closest two centroids and the mean within-
    /// speaker distance. Higher is more conservative.
    pub min_separation: f32,
    pub min_cluster_ms: u32,
    pub min_cluster_windows: usize,
    /// If adjacent windows change speaker more often than this, the split is
    /// treated as noise and collapsed to one speaker.
    pub max_transition_rate: f32,
    /// Prefer fewer speakers unless the extra split is substantially better.
    pub k_penalty: f32,
}

impl Default for ClusterConfig {
    fn default() -> Self {
        Self {
            max_speakers: 6,
            min_separation: 2.2,
            min_cluster_ms: 4_000,
            min_cluster_windows: 3,
            max_transition_rate: 0.35,
            k_penalty: 0.35,
        }
    }
}

pub struct Clustering {
    /// Zero-based cluster index for every input embedding.
    pub assignments: Vec<usize>,
    pub speakers: usize,
    pub separation: f32,
}

pub fn cluster(
    embeddings: &[Vec<f32>],
    durations_ms: &[u32],
    config: &ClusterConfig,
) -> Clustering {
    let count = embeddings.len().min(durations_ms.len());
    if count == 0 {
        return Clustering {
            assignments: Vec::new(),
            speakers: 0,
            separation: 0.0,
        };
    }
    let embeddings = &embeddings[..count];
    let durations_ms = &durations_ms[..count];

    let points = prepare(embeddings);
    let max_k = config
        .max_speakers
        .min(count / config.min_cluster_windows.max(1))
        .max(1);

    if max_k < 2 {
        return Clustering {
            assignments: vec![0; count],
            speakers: 1,
            separation: 0.0,
        };
    }

    let mut best: Option<(usize, Vec<usize>, f32)> = None;
    for k in 2..=max_k {
        let (assignments, centers) = kmeans(&points, k);
        if !clusters_are_plausible(&assignments, durations_ms, k, config) {
            continue;
        }
        if transition_rate(&assignments) > config.max_transition_rate {
            continue;
        }
        let separation = separation(&points, &assignments, &centers);
        if separation < config.min_separation {
            continue;
        }
        let score = separation - config.k_penalty * (k as f32 - 2.0);
        if best
            .as_ref()
            .map(|(_, _, best_score)| score > *best_score)
            .unwrap_or(true)
        {
            best = Some((k, assignments, separation));
        }
    }

    match best {
        Some((k, assignments, separation)) => Clustering {
            assignments,
            speakers: k,
            separation,
        },
        None => Clustering {
            assignments: vec![0; count],
            speakers: 1,
            separation: 0.0,
        },
    }
}

/// L2-normalize each embedding. The blocks already have different magnitudes
/// (cepstral means dominate the small delta statistics), which acts as a
/// useful prior: speaker identity lives mostly in the long-term spectrum.
/// Per-meeting standardization was tested and rejected because it amplified
/// frame-grid noise in near-identical windows.
fn prepare(embeddings: &[Vec<f32>]) -> Vec<Vec<f32>> {
    embeddings
        .iter()
        .map(|embedding| {
            let mut normalized = embedding.clone();
            l2_normalize(&mut normalized);
            normalized
        })
        .collect()
}

fn l2_normalize(values: &mut [f32]) {
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 1e-8 {
        for value in values {
            *value /= norm;
        }
    }
}

fn kmeans(points: &[Vec<f32>], k: usize) -> (Vec<usize>, Vec<Vec<f32>>) {
    let dimensions = points[0].len();
    let mut centers = init_centers(points, k, dimensions);
    let mut assignments = vec![usize::MAX; points.len()];

    for _ in 0..50 {
        let mut changed = false;
        for (index, point) in points.iter().enumerate() {
            let nearest = nearest_center(point, &centers);
            if assignments[index] != nearest {
                assignments[index] = nearest;
                changed = true;
            }
        }

        let mut sums = vec![vec![0.0f32; dimensions]; k];
        let mut counts = vec![0usize; k];
        for (index, point) in points.iter().enumerate() {
            let cluster = assignments[index];
            counts[cluster] += 1;
            for (dimension, value) in point.iter().enumerate() {
                sums[cluster][dimension] += value;
            }
        }
        for (cluster, sum) in sums.iter_mut().enumerate() {
            if counts[cluster] == 0 {
                continue;
            }
            for value in sum.iter_mut() {
                *value /= counts[cluster] as f32;
            }
            l2_normalize(sum);
            centers[cluster] = sum.clone();
        }

        if !changed {
            break;
        }
    }

    // A degenerate init can leave a cluster empty. Give every point a label
    // rather than returning `usize::MAX`.
    for assignment in &mut assignments {
        if *assignment == usize::MAX {
            *assignment = 0;
        }
    }
    (assignments, centers)
}

fn init_centers(points: &[Vec<f32>], k: usize, dimensions: usize) -> Vec<Vec<f32>> {
    let mut mean = vec![0.0f32; dimensions];
    for point in points {
        for (index, value) in point.iter().enumerate() {
            mean[index] += value;
        }
    }
    for value in &mut mean {
        *value /= points.len() as f32;
    }

    let first = points
        .iter()
        .enumerate()
        .max_by(|left, right| dot(left.1, &mean).total_cmp(&dot(right.1, &mean)))
        .map(|(index, _)| index)
        .unwrap_or(0);
    let mut centers = vec![points[first].clone()];

    while centers.len() < k {
        let mut farthest = 0usize;
        let mut farthest_distance = f32::NEG_INFINITY;
        for (index, point) in points.iter().enumerate() {
            let distance = centers
                .iter()
                .map(|center| 1.0 - dot(point, center))
                .fold(f32::INFINITY, f32::min);
            if distance > farthest_distance {
                farthest_distance = distance;
                farthest = index;
            }
        }
        centers.push(points[farthest].clone());
    }
    centers
}

fn nearest_center(point: &[f32], centers: &[Vec<f32>]) -> usize {
    let mut best = 0usize;
    let mut best_similarity = f32::NEG_INFINITY;
    for (index, center) in centers.iter().enumerate() {
        let similarity = dot(point, center);
        if similarity > best_similarity {
            best_similarity = similarity;
            best = index;
        }
    }
    best
}

fn dot(left: &[f32], right: &[f32]) -> f32 {
    left.iter().zip(right).map(|(a, b)| a * b).sum()
}

fn clusters_are_plausible(
    assignments: &[usize],
    durations_ms: &[u32],
    k: usize,
    config: &ClusterConfig,
) -> bool {
    let mut counts = vec![0usize; k];
    let mut durations = vec![0u64; k];
    for (index, cluster) in assignments.iter().copied().enumerate() {
        counts[cluster] += 1;
        durations[cluster] += durations_ms[index] as u64;
    }
    counts.iter().zip(&durations).all(|(count, duration)| {
        *count >= config.min_cluster_windows && *duration >= config.min_cluster_ms as u64
    })
}

fn transition_rate(assignments: &[usize]) -> f32 {
    if assignments.len() < 2 {
        return 0.0;
    }
    let changes = assignments
        .windows(2)
        .filter(|pair| pair[0] != pair[1])
        .count();
    changes as f32 / (assignments.len() - 1) as f32
}

fn separation(points: &[Vec<f32>], assignments: &[usize], centers: &[Vec<f32>]) -> f32 {
    let within: f32 = points
        .iter()
        .enumerate()
        .map(|(index, point)| 1.0 - dot(point, &centers[assignments[index]]))
        .sum::<f32>()
        / points.len() as f32;
    let mut closest = f32::INFINITY;
    for left in 0..centers.len() {
        for right in (left + 1)..centers.len() {
            closest = closest.min(1.0 - dot(&centers[left], &centers[right]));
        }
    }
    if !closest.is_finite() {
        return 0.0;
    }
    closest / within.max(0.01)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(state: &mut u64) -> f32 {
        *state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((*state >> 40) as f32) / ((1u64 << 24) as f32)
    }

    fn noise(state: &mut u64, dimensions: usize) -> Vec<f32> {
        (0..dimensions)
            .map(|_| lcg(state) + lcg(state) + lcg(state) - 1.5)
            .collect()
    }

    fn cloud(base: &[f32], count: usize, spread: f32, seed: u64) -> Vec<Vec<f32>> {
        let mut state = seed;
        (0..count)
            .map(|_| {
                let noise = noise(&mut state, base.len());
                base.iter()
                    .zip(noise)
                    .map(|(value, delta)| value + delta * spread)
                    .collect()
            })
            .collect()
    }

    fn unimodal() -> (Vec<Vec<f32>>, Vec<u32>) {
        let mut state = 7;
        let base = noise(&mut state, 40);
        let points = cloud(&base, 90, 0.6, 11);
        let durations = vec![1_500; points.len()];
        (points, durations)
    }

    fn bimodal() -> (Vec<Vec<f32>>, Vec<u32>) {
        let mut state = 7;
        let mut first = noise(&mut state, 40);
        let mut second = noise(&mut state, 40);
        for value in first.iter_mut().take(10) {
            *value += 1.5;
        }
        for value in second.iter_mut().take(10) {
            *value -= 1.5;
        }
        let mut points = cloud(&first, 45, 0.3, 21);
        points.extend(cloud(&second, 45, 0.3, 22));
        let durations = vec![1_500; points.len()];
        (points, durations)
    }

    #[test]
    fn a_single_cloud_stays_one_speaker() {
        let (points, durations) = unimodal();
        let result = cluster(&points, &durations, &ClusterConfig::default());
        assert_eq!(result.speakers, 1);
    }

    #[test]
    fn two_separated_clouds_become_two_speakers() {
        let (points, durations) = bimodal();
        let result = cluster(&points, &durations, &ClusterConfig::default());
        assert_eq!(result.speakers, 2);
        assert_eq!(result.assignments[0], result.assignments[44]);
        assert_eq!(result.assignments[45], result.assignments[89]);
        assert_ne!(result.assignments[0], result.assignments[45]);
    }

    #[test]
    fn a_single_window_is_one_speaker() {
        let result = cluster(&[vec![1.0, 0.0]], &[1_500], &ClusterConfig::default());
        assert_eq!(result.speakers, 1);
        assert_eq!(result.assignments, vec![0]);
    }

    #[test]
    fn clusters_below_the_duration_floor_are_rejected() {
        let (points, _) = bimodal();
        let durations = vec![10; points.len()];
        let result = cluster(&points, &durations, &ClusterConfig::default());
        assert_eq!(result.speakers, 1);
    }
}
