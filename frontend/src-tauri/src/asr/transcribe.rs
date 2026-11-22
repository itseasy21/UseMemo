//! Meeting-level transcription: streaming WAV decode, pause-aware VAD chunking,
//! Metal/CPU Whisper recognition, acoustic speaker attribution, and rolling live captions.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use memo_diarize::{
    cosine_similarity, decode_centroid_bytes, diarize, speaker_at, voiceprint_centroid,
    Diarization, DiarizationConfig,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

use crate::asr::engine::{
    clean_text, is_silent, vad_block_ranges, AsrEngine, AsrOptions, BLOCK_MS,
};
use crate::audio::AudioChannel;
use crate::error::{AppError, AppResult};
use crate::events::{AsrProgressPayload, AsrSegmentDeltaPayload, MeetingChangedPayload};
#[cfg(feature = "asr")]
use crate::model_registry::{catalog, HardwareProfile, ModelRole};
use crate::state::AppState;
use crate::storage::{NewTranscriptSegment, Speaker};

/// The microphone is always the local user; loopback speech is split into
/// `Speaker N` only when the acoustic clustering actually separates voices.
/// Falling back to `Them` is intentional: a channel label is a fact, a guessed
/// identity is not.
const MIC_LABEL: &str = "You";
const MIC_CHANNEL: &str = "mic";
const SYSTEM_LABEL: &str = "Them";
const SYSTEM_CHANNEL: &str = "system";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOutcome {
    pub engine_id: String,
    pub model_id: String,
    pub segments: usize,
    pub blocks: usize,
    pub skipped_blocks: usize,
    pub channels: usize,
    pub speaker_count: usize,
    pub duration_ms: i64,
}

struct SourceTrack {
    channel: AudioChannel,
    path: PathBuf,
    /// Where this archive begins on the meeting timeline.
    offset_ms: i64,
}

struct DecodedTrack {
    channel: AudioChannel,
    offset_ms: i64,
    samples: Arc<Vec<f32>>,
}

/// Transcribe a meeting's archive, replacing any previous transcript.
///
/// The meeting always leaves this function `completed`: a transcription failure
/// or user cancellation must never strand a take in `processing` when the audio
/// is perfectly intact.
pub async fn transcribe_meeting(
    app: &AppHandle,
    state: &AppState,
    meeting_id: &str,
) -> AppResult<TranscriptionOutcome> {
    {
        let active = state.recording.lock().await;
        if active
            .as_ref()
            .is_some_and(|runtime| runtime.meeting_id == meeting_id)
        {
            return Err(AppError::Asr(
                "stop the active recording before running full post-meeting transcription".into(),
            ));
        }
    }

    let _serial = state.transcribing.lock().await;
    state.asr_cancelled.store(false, Ordering::SeqCst);

    let meeting = state.db.get_meeting(meeting_id).await?;
    let mut sources = Vec::with_capacity(2);
    if let Some(path) = meeting.audio_file_path.clone() {
        sources.push(SourceTrack {
            channel: AudioChannel::Microphone,
            path: PathBuf::from(path),
            offset_ms: 0,
        });
    }
    if let Some(path) = meeting.system_audio_file_path.clone() {
        sources.push(SourceTrack {
            channel: AudioChannel::System,
            path: PathBuf::from(path),
            offset_ms: meeting.system_audio_started_at_ms.max(0),
        });
    }
    if sources.is_empty() {
        return Err(AppError::Asr("this meeting has no recorded audio".into()));
    }

    let speakers = state.db.list_speakers().await.unwrap_or_default();
    let initial_prompt = build_initial_prompt(&meeting.title, &speakers);
    let fallback_duration = meeting.duration_ms;

    state
        .db
        .set_meeting_status(meeting_id, "processing")
        .await?;
    let _ = emit_progress(app, meeting_id, "loading", 0.0, 0, 0, 0);

    let result = run(
        app,
        state,
        meeting_id,
        &sources,
        &meeting.asr_model_id,
        meeting.diarization_enabled,
        initial_prompt.as_deref(),
    )
    .await;
    let duration = result
        .as_ref()
        .map(|outcome| outcome.duration_ms)
        .unwrap_or(fallback_duration);

    let meeting = state.db.finish_meeting(meeting_id, duration).await?;
    let _ = app.emit(
        "meeting:changed",
        MeetingChangedPayload {
            meeting: meeting.clone(),
        },
    );

    match result {
        Ok(outcome) => {
            let _ = emit_progress(
                app,
                meeting_id,
                "complete",
                100.0,
                outcome.segments,
                outcome.duration_ms,
                outcome.duration_ms,
            );
            Ok(outcome)
        }
        Err(error) => {
            let stage = if state.asr_cancelled.load(Ordering::SeqCst) {
                "cancelled"
            } else {
                "failed"
            };
            let _ = emit_progress(app, meeting_id, stage, 100.0, 0, duration, duration);
            tracing::warn!(
                meeting_id = %meeting_id,
                stage,
                error = %error,
                "transcription did not complete"
            );
            Err(error)
        }
    }
}

async fn run(
    app: &AppHandle,
    state: &AppState,
    meeting_id: &str,
    sources: &[SourceTrack],
    preferred_model: &str,
    diarization_enabled: bool,
    initial_prompt: Option<&str>,
) -> AppResult<TranscriptionOutcome> {
    let mut tracks = Vec::with_capacity(sources.len());
    for source in sources {
        if state.asr_cancelled.load(Ordering::SeqCst) {
            return Err(AppError::Asr("transcription cancelled".into()));
        }
        let path = source.path.clone();
        let samples = tokio::task::spawn_blocking(move || decode_16k_streaming(&path))
            .await
            .map_err(|error| AppError::Asr(format!("decode task failed: {error}")))??;
        tracks.push(DecodedTrack {
            channel: source.channel,
            offset_ms: source.offset_ms,
            samples: Arc::new(samples),
        });
    }

    let duration_ms = tracks
        .iter()
        .map(|track| track.offset_ms + samples_to_ms(track.samples.len()))
        .max()
        .unwrap_or(0);
    let engine = engine_for(state, preferred_model).await?;

    let per_block_samples = (16_000 * BLOCK_MS / 1_000) as usize;
    let ranges_per_track: Vec<_> = tracks
        .iter()
        .map(|track| vad_block_ranges(&track.samples, per_block_samples))
        .collect();
    let total_ranges: usize = ranges_per_track.iter().map(Vec::len).sum();
    let mut processed_ranges = 0usize;
    let mut processed_ms = 0i64;

    let mut pending: Vec<NewTranscriptSegment> = Vec::new();
    let mut skipped_blocks = 0usize;
    let mut blocks = 0usize;
    let prompt_arc: Option<Arc<str>> = initial_prompt.map(Arc::from);

    for (track, ranges) in tracks.iter().zip(ranges_per_track.iter()) {
        let channel = match track.channel {
            AudioChannel::Microphone => MIC_CHANNEL,
            AudioChannel::System => SYSTEM_CHANNEL,
        };

        let diarization = if diarization_enabled && track.channel == AudioChannel::System {
            let samples = Arc::clone(&track.samples);
            let config = DiarizationConfig::default();
            Some(
                tokio::task::spawn_blocking(move || diarize(&samples, &config))
                    .await
                    .map_err(|error| AppError::Asr(format!("diarization task failed: {error}")))?,
            )
        } else {
            None
        };

        let enrolled_names = if state.brand.manifest().features.enable_voiceprint_enrollment {
            if let Some(ref diar) = diarization {
                let speakers = state.db.list_speakers().await.unwrap_or_default();
                let samples = Arc::clone(&track.samples);
                let diar_clone = diar.clone();
                tokio::task::spawn_blocking(move || {
                    match_enrolled_voiceprints(&samples, &diar_clone, &speakers)
                })
                .await
                .unwrap_or_default()
            } else {
                BTreeMap::new()
            }
        } else {
            BTreeMap::new()
        };

        for (start, end) in ranges {
            if state.asr_cancelled.load(Ordering::SeqCst) {
                return Err(AppError::Asr("transcription cancelled".into()));
            }
            let block = &track.samples[*start..*end];
            let block_track_ms = samples_to_ms(*start);
            let offset_ms = track.offset_ms + block_track_ms;

            if is_silent(block) {
                skipped_blocks += 1;
            } else {
                blocks += 1;
                let engine = Arc::clone(&engine);
                let owned = block.to_vec();
                let prompt = prompt_arc.clone();
                let segments = tokio::task::spawn_blocking(move || {
                    engine.transcribe_with_options(
                        &owned,
                        AsrOptions {
                            language: None,
                            initial_prompt: prompt.as_deref(),
                        },
                    )
                })
                .await
                .map_err(|error| AppError::Asr(format!("inference task failed: {error}")))??;

                for segment in segments {
                    let Some(text) = clean_text(&segment.text) else {
                        continue;
                    };
                    let relative_start = segment.start_ms.max(0);
                    let relative_end = segment.end_ms.max(relative_start);
                    // Diarization turns live on the track-local sample timeline, NOT
                    // the 0..30s block-relative timeline. Adding `block_track_ms`
                    // keeps Speaker 1 / Speaker 2 distinct across multi-minute recordings.
                    let track_start_ms = block_track_ms + relative_start;
                    let track_end_ms = block_track_ms + relative_end;
                    let start_ms = offset_ms + relative_start;
                    let end_ms = (offset_ms + relative_end).max(start_ms);

                    let raw_label = label_for(
                        track.channel,
                        diarization.as_ref(),
                        track_start_ms,
                        track_end_ms,
                    );
                    let resolved_label =
                        enrolled_names.get(&raw_label).cloned().unwrap_or(raw_label);

                    pending.push(NewTranscriptSegment {
                        seq_no: 0,
                        start_ms,
                        end_ms,
                        speaker_label: resolved_label,
                        audio_channel: channel.into(),
                        text,
                        is_confirmed: true,
                    });
                }
            }

            processed_ranges += 1;
            processed_ms += samples_to_ms(*end - *start);
            let percent = if total_ranges == 0 {
                100.0
            } else {
                (processed_ranges as f32 / total_ranges as f32) * 100.0
            };
            let _ = emit_progress(
                app,
                meeting_id,
                "transcribing",
                percent,
                pending.len(),
                processed_ms,
                duration_ms,
            );
        }
    }

    let pending = merge_channels(pending);

    let stored = state.db.replace_transcript(meeting_id, pending).await?;
    let speaker_count = stored
        .iter()
        .map(|segment| segment.speaker_label.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    for segment in &stored {
        let _ = app.emit(
            crate::events::ASR_SEGMENT_DELTA,
            AsrSegmentDeltaPayload {
                meeting_id: meeting_id.to_string(),
                seq_no: segment.seq_no,
                start_ms: segment.start_ms,
                end_ms: segment.end_ms,
                speaker_label: segment.speaker_label.clone(),
                text: segment.text.clone(),
                is_final: true,
            },
        );
    }

    Ok(TranscriptionOutcome {
        engine_id: engine.engine_id().to_string(),
        model_id: engine.model_id().to_string(),
        segments: stored.len(),
        blocks,
        skipped_blocks,
        channels: tracks.len(),
        speaker_count,
        duration_ms,
    })
}

/// Spawn a rolling live-caption task during active recording when an ASR model
/// is installed and hardware allows keeping ASR warm.
///
/// Tails newly flushed PCM frames from `audio_path` every ~5 seconds without
/// interfering with WAV writing, emitting `asr:segment-delta` and persisting
/// live transcript rows into SQLite.
pub fn spawn_live_caption_worker(
    app: AppHandle,
    meeting_id: String,
    audio_path: PathBuf,
    preferred_model: String,
    mut cancel_rx: watch::Receiver<bool>,
) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if !state.hardware.tier.keep_asr_warm() {
            return;
        }
        let Ok(engine) = engine_for(&state, &preferred_model).await else {
            return;
        };

        let mut cursor_frames: u64 = 0;
        let mut next_seq_no: i64 = state
            .db
            .list_transcript(&meeting_id)
            .await
            .ok()
            .and_then(|rows| rows.last().map(|seg| seg.seq_no + 1))
            .unwrap_or(1);

        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    // Yield immediately if a full post-meeting transcription holds the lock.
                    let Ok(_guard) = state.transcribing.try_lock() else {
                        continue;
                    };
                    let path = audio_path.clone();
                    let from_frame = cursor_frames;
                    let Ok(Ok(Some((new_cursor, window_start_ms, chunk_16k)))) =
                        tokio::task::spawn_blocking(move || read_tail_16k(&path, from_frame)).await
                    else {
                        continue;
                    };
                    cursor_frames = new_cursor;
                    if is_silent(&chunk_16k) {
                        continue;
                    }

                    let engine_clone = Arc::clone(&engine);
                    let Ok(Ok(decoded)) = tokio::task::spawn_blocking(move || {
                        engine_clone.transcribe(&chunk_16k, None)
                    }).await else {
                        continue;
                    };

                    for seg in decoded {
                        let Some(text) = clean_text(&seg.text) else {
                            continue;
                        };
                        let start_ms = window_start_ms + seg.start_ms.max(0);
                        let end_ms = (window_start_ms + seg.end_ms).max(start_ms);
                        let seq_no = next_seq_no;
                        next_seq_no += 1;

                        if let Ok(saved) = state
                            .db
                            .insert_transcript_segment(
                                &meeting_id,
                                NewTranscriptSegment {
                                    seq_no,
                                    start_ms,
                                    end_ms,
                                    speaker_label: MIC_LABEL.into(),
                                    audio_channel: MIC_CHANNEL.into(),
                                    text,
                                    is_confirmed: false,
                                },
                            )
                            .await
                        {
                            let _ = app.emit(
                                crate::events::ASR_SEGMENT_DELTA,
                                AsrSegmentDeltaPayload {
                                    meeting_id: meeting_id.clone(),
                                    seq_no: saved.seq_no,
                                    start_ms: saved.start_ms,
                                    end_ms: saved.end_ms,
                                    speaker_label: saved.speaker_label,
                                    text: saved.text,
                                    is_final: false,
                                },
                            );
                        }
                    }
                }
                changed = cancel_rx.changed() => {
                    if changed.is_err() || *cancel_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });
}

fn read_tail_16k(path: &Path, from_frame: u64) -> AppResult<Option<(u64, i64, Vec<f32>)>> {
    if !path.is_file() {
        return Ok(None);
    }
    let mut reader = memo_audio_capture::wav::WavStreamReader::open(path)
        .map_err(|error| AppError::Asr(error.to_string()))?;
    let total = reader.total_frames();
    let sample_rate = reader.sample_rate().max(1);
    let min_new_frames = u64::from(sample_rate) * 4; // Wait for at least 4s of fresh audio
    if total.saturating_sub(from_frame) < min_new_frames {
        return Ok(None);
    }

    // Cap single live-caption tail window to 25 seconds so rolling ticks stay bounded.
    let max_window_frames = u64::from(sample_rate) * 25;
    let effective_start = from_frame.max(total.saturating_sub(max_window_frames));
    reader
        .seek_frame(effective_start)
        .map_err(|error| AppError::Asr(error.to_string()))?;

    let frames_to_read = (total - effective_start) as usize;
    let mut raw = Vec::with_capacity(frames_to_read);
    reader
        .read_mono_f32(frames_to_read, &mut raw)
        .map_err(|error| AppError::Asr(error.to_string()))?;

    let samples_16k = if sample_rate == 16_000 {
        raw
    } else {
        let mut resampler = memo_audio_capture::SincResampler::new(sample_rate, 16_000)
            .map_err(|error| AppError::Asr(error.to_string()))?;
        let mut out =
            Vec::with_capacity((raw.len() as u64 * 16_000 / u64::from(sample_rate)) as usize + 64);
        resampler.process(&raw, &mut out);
        resampler.finish(&mut out);
        out
    };

    let window_start_ms = (effective_start as u128 * 1_000 / sample_rate as u128) as i64;
    Ok(Some((total, window_start_ms, samples_16k)))
}

fn build_initial_prompt(title: &str, speakers: &[Speaker]) -> Option<String> {
    let mut parts = Vec::new();
    let clean_title = title.trim();
    if !clean_title.is_empty() && !clean_title.starts_with("Memo ") {
        parts.push(format!("Topic: {clean_title}."));
    }
    let names: Vec<&str> = speakers
        .iter()
        .map(|s| s.display_name.trim())
        .filter(|name| {
            !name.is_empty()
                && *name != MIC_LABEL
                && *name != SYSTEM_LABEL
                && !name.starts_with("Speaker ")
        })
        .take(8)
        .collect();
    if !names.is_empty() {
        parts.push(format!("Participants: {}.", names.join(", ")));
    }
    if parts.is_empty() {
        return None;
    }
    let joined = parts.join(" ");
    Some(joined.chars().take(240).collect())
}

fn label_for(
    channel: AudioChannel,
    diarization: Option<&Diarization>,
    start_ms: i64,
    end_ms: i64,
) -> String {
    if channel == AudioChannel::Microphone {
        return MIC_LABEL.to_string();
    }
    match diarization {
        Some(result) if result.speakers > 1 => speaker_at(&result.turns, start_ms, end_ms)
            .map(|speaker| format!("Speaker {speaker}"))
            .unwrap_or_else(|| SYSTEM_LABEL.to_string()),
        _ => SYSTEM_LABEL.to_string(),
    }
}

/// Compute an acoustic voiceprint centroid for `(start_ms, end_ms)` ranges on a WAV track.
pub fn compute_voiceprint_for_wav(path: &Path, ranges_ms: &[(i64, i64)]) -> Option<Vec<f32>> {
    if !path.is_file() || ranges_ms.is_empty() {
        return None;
    }
    let samples_16k = decode_16k_streaming(path).ok()?;
    voiceprint_centroid(&samples_16k, ranges_ms)
}

fn match_enrolled_voiceprints(
    samples_16k: &[f32],
    diarization: &Diarization,
    speakers: &[Speaker],
) -> BTreeMap<String, String> {
    let mut enrolled: Vec<(&str, Vec<f32>)> = Vec::new();
    for sp in speakers {
        if sp.is_local_user {
            continue;
        }
        if let Some(centroid) = sp
            .voiceprint_centroid
            .as_deref()
            .and_then(decode_centroid_bytes)
        {
            enrolled.push((sp.display_name.as_str(), centroid));
        }
    }
    if enrolled.is_empty() || diarization.speakers <= 1 {
        return BTreeMap::new();
    }

    let mut mapping = BTreeMap::new();
    let mut claimed: BTreeSet<&str> = BTreeSet::new();

    for cluster_id in 1..=diarization.speakers {
        let ranges: Vec<(i64, i64)> = diarization
            .turns
            .iter()
            .filter(|turn| turn.speaker == cluster_id)
            .map(|turn| (turn.start_ms, turn.end_ms))
            .collect();
        let Some(cluster_centroid) = voiceprint_centroid(samples_16k, &ranges) else {
            continue;
        };

        let mut best_name: Option<&str> = None;
        let mut best_sim = -1.0f32;
        let mut second_sim = -1.0f32;

        for (name, ref_centroid) in &enrolled {
            if claimed.contains(name) {
                continue;
            }
            let sim = cosine_similarity(&cluster_centroid, ref_centroid);
            if sim > best_sim {
                second_sim = best_sim;
                best_sim = sim;
                best_name = Some(name);
            } else if sim > second_sim {
                second_sim = sim;
            }
        }

        if let Some(name) = best_name {
            if best_sim >= 0.92 && (enrolled.len() == 1 || best_sim - second_sim >= 0.04) {
                claimed.insert(name);
                mapping.insert(format!("Speaker {cluster_id}"), name.to_string());
            }
        }
    }

    mapping
}

/// Order both channels on one clock, microphone first on an exact tie, then
/// renumber `seq_no` from 1 so the transcript list has a stable order.
fn merge_channels(mut segments: Vec<NewTranscriptSegment>) -> Vec<NewTranscriptSegment> {
    segments.sort_by_key(|segment| {
        (
            segment.start_ms,
            u8::from(segment.audio_channel == SYSTEM_CHANNEL),
        )
    });
    for (index, segment) in segments.iter_mut().enumerate() {
        segment.seq_no = index as i64 + 1;
    }
    segments
}

fn samples_to_ms(samples: usize) -> i64 {
    (samples as i128 * 1_000 / 16_000) as i64
}

/// Return a cached engine, loading the installed model on first use and caching
/// under the resolved artifact's actual `model_id()`.
async fn engine_for(state: &AppState, preferred_model: &str) -> AppResult<Arc<dyn AsrEngine>> {
    let mut cache = state.asr.lock().await;
    #[cfg(feature = "asr")]
    let resolved_target = installed_asr_model(
        &state.brand.manifest().model_registry,
        &state.paths.models_dir,
        preferred_model,
    )
    .ok()
    .map(|(_, id)| id);
    #[cfg(not(feature = "asr"))]
    let resolved_target: Option<String> = None;

    if let Some(cached) = cache.as_mut() {
        if cached.model_id == preferred_model
            || resolved_target
                .as_deref()
                .is_some_and(|target| target == cached.model_id)
        {
            cached.last_used = std::time::Instant::now();
            return Ok(Arc::clone(&cached.engine));
        }
    }

    let registry = state.brand.manifest().model_registry.clone();
    let models_dir = state.paths.models_dir.clone();
    let preferred = preferred_model.to_string();
    let engine =
        tokio::task::spawn_blocking(move || load_engine(&registry, &models_dir, &preferred))
            .await
            .map_err(|error| AppError::Asr(format!("model load task failed: {error}")))??;

    let actual_model_id = engine.model_id().to_string();
    tracing::info!(
        model_id = %actual_model_id,
        "loaded on-device ASR model into memory"
    );
    *cache = Some(crate::state::CachedAsr {
        model_id: actual_model_id,
        engine: Arc::clone(&engine),
        last_used: std::time::Instant::now(),
    });

    if !state.asr_reaper_active.swap(true, Ordering::SeqCst) {
        let asr_holder = Arc::clone(&state.asr);
        let reaper_active = Arc::clone(&state.asr_reaper_active);
        let is_recording = Arc::clone(&state.is_recording);
        let idle_timeout = std::time::Duration::from_secs(120);

        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                if is_recording.load(Ordering::SeqCst) {
                    continue;
                }
                let mut guard = asr_holder.lock().await;
                if is_recording.load(Ordering::SeqCst) {
                    continue;
                }
                if let Some(cached) = guard.as_ref() {
                    let elapsed = cached.last_used.elapsed();
                    if elapsed >= idle_timeout {
                        tracing::info!(
                            model_id = %cached.model_id,
                            idle_secs = elapsed.as_secs(),
                            "unloading idle ASR model to release RAM"
                        );
                        *guard = None;
                        reaper_active.store(false, Ordering::SeqCst);
                        break;
                    }
                } else {
                    reaper_active.store(false, Ordering::SeqCst);
                    break;
                }
            }
        });
    }

    Ok(engine)
}

/// Load the first installed ASR artifact, preferring the meeting's choice.
#[cfg(feature = "asr")]
fn load_engine(
    registry: &crate::brand::ModelRegistry,
    models_dir: &Path,
    preferred: &str,
) -> AppResult<Arc<dyn AsrEngine>> {
    let (path, model_id) = installed_asr_model(registry, models_dir, preferred)?;
    let engine = crate::asr::WhisperEngine::load(&path, model_id)?;
    Ok(Arc::new(engine))
}

#[cfg(not(feature = "asr"))]
fn load_engine(
    _registry: &crate::brand::ModelRegistry,
    _models_dir: &Path,
    _preferred: &str,
) -> AppResult<Arc<dyn AsrEngine>> {
    Err(AppError::Asr(
        "this build was compiled without a speech engine; rebuild with the `asr` feature".into(),
    ))
}

#[cfg(feature = "asr")]
fn installed_asr_model(
    registry: &crate::brand::ModelRegistry,
    models_dir: &Path,
    preferred: &str,
) -> AppResult<(PathBuf, String)> {
    let hardware = HardwareProfile::detect();
    let mut candidates: Vec<_> = catalog(registry, &hardware)
        .into_iter()
        .filter(|artifact| matches!(artifact.role, ModelRole::Asr | ModelRole::FallbackAsr))
        .collect();
    candidates.sort_by_key(|artifact| u8::from(artifact.id != preferred));

    for artifact in candidates {
        if !artifact.is_installed(models_dir) {
            continue;
        }
        let Some(file) = artifact.files.first() else {
            continue;
        };
        return Ok((artifact.local_path(models_dir, &file.filename), artifact.id));
    }

    Err(AppError::Asr(
        "no speech model is installed; download one in Model Studio".into(),
    ))
}

/// Stream a WAV file in bounded 64k-frame chunks directly into a 16 kHz mono
/// buffer without materializing a full-rate 48 kHz copy in memory.
fn decode_16k_streaming(path: &Path) -> AppResult<Vec<f32>> {
    let mut reader = memo_audio_capture::wav::WavStreamReader::open(path)
        .map_err(|error| AppError::Asr(error.to_string()))?;
    let sample_rate = reader.sample_rate();
    let total_frames = reader.total_frames() as usize;
    let estimated_16k =
        ((total_frames as u128 * 16_000) / u128::from(sample_rate.max(1))) as usize + 128;

    const CHUNK_FRAMES: usize = 65_536;
    if sample_rate == 16_000 {
        let mut out = Vec::with_capacity(total_frames);
        loop {
            let read = reader
                .read_mono_f32(CHUNK_FRAMES, &mut out)
                .map_err(|error| AppError::Asr(error.to_string()))?;
            if read == 0 {
                break;
            }
        }
        return Ok(out);
    }

    let mut resampler = memo_audio_capture::SincResampler::new(sample_rate, 16_000)
        .map_err(|error| AppError::Asr(error.to_string()))?;
    let mut out = Vec::with_capacity(estimated_16k);
    let mut chunk = Vec::with_capacity(CHUNK_FRAMES);
    loop {
        chunk.clear();
        let read = reader
            .read_mono_f32(CHUNK_FRAMES, &mut chunk)
            .map_err(|error| AppError::Asr(error.to_string()))?;
        if read == 0 {
            break;
        }
        resampler.process(&chunk, &mut out);
    }
    resampler.finish(&mut out);
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    meeting_id: &str,
    stage: &str,
    percent: f32,
    segments: usize,
    processed_ms: i64,
    total_ms: i64,
) -> AppResult<()> {
    app.emit(
        crate::events::ASR_PROGRESS,
        AsrProgressPayload {
            meeting_id: meeting_id.to_string(),
            stage: stage.to_string(),
            percent,
            segments,
            processed_ms,
            total_ms,
        },
    )
    .map_err(|error| AppError::Invalid(format!("cannot emit asr progress: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thirty_second_blocks_are_480k_samples() {
        assert_eq!((16_000 * BLOCK_MS / 1_000) as usize, 480_000);
    }

    #[test]
    fn outcome_serializes_as_camel_case() {
        let outcome = TranscriptionOutcome {
            engine_id: "whisper-rs-metal".into(),
            model_id: "whisper-small".into(),
            segments: 12,
            blocks: 3,
            skipped_blocks: 1,
            channels: 2,
            speaker_count: 3,
            duration_ms: 90_000,
        };
        let value = serde_json::to_value(outcome).unwrap();
        assert_eq!(value["engineId"], "whisper-rs-metal");
        assert_eq!(value["skippedBlocks"], 1);
        assert_eq!(value["channels"], 2);
        assert_eq!(value["speakerCount"], 3);
    }

    fn segment(start_ms: i64, channel: &str) -> NewTranscriptSegment {
        NewTranscriptSegment {
            seq_no: 0,
            start_ms,
            end_ms: start_ms + 500,
            speaker_label: if channel == SYSTEM_CHANNEL {
                SYSTEM_LABEL.into()
            } else {
                MIC_LABEL.into()
            },
            audio_channel: channel.into(),
            text: format!("{channel} at {start_ms}"),
            is_confirmed: true,
        }
    }

    #[test]
    fn channel_labels_stay_honest_without_diarization() {
        assert_eq!(
            label_for(AudioChannel::Microphone, None, 0, 1_000),
            MIC_LABEL
        );
        assert_eq!(
            label_for(AudioChannel::System, None, 0, 1_000),
            SYSTEM_LABEL
        );

        let diarization = Diarization {
            turns: vec![memo_diarize::SpeakerTurn {
                start_ms: 0,
                end_ms: 1_000,
                speaker: 2,
            }],
            speakers: 2,
            speech_ms: 1_000,
            windows: 1,
        };
        assert_eq!(
            label_for(AudioChannel::System, Some(&diarization), 100, 900),
            "Speaker 2"
        );
    }

    #[test]
    fn diarization_labels_remain_distinct_past_thirty_second_block_boundary() {
        let diarization = Diarization {
            turns: vec![
                memo_diarize::SpeakerTurn {
                    start_ms: 0,
                    end_ms: 28_000,
                    speaker: 1,
                },
                memo_diarize::SpeakerTurn {
                    start_ms: 31_000,
                    end_ms: 58_000,
                    speaker: 2,
                },
                memo_diarize::SpeakerTurn {
                    start_ms: 61_000,
                    end_ms: 85_000,
                    speaker: 1,
                },
            ],
            speakers: 2,
            speech_ms: 82_000,
            windows: 55,
        };

        // Block 1 (0..30s), relative [2s..6s] -> Speaker 1
        let block0_ms = samples_to_ms(0);
        assert_eq!(
            label_for(
                AudioChannel::System,
                Some(&diarization),
                block0_ms + 2_000,
                block0_ms + 6_000,
            ),
            "Speaker 1"
        );

        // Block 2 (30..60s), relative [2s..6s] -> track-local [32s..36s] -> Speaker 2!
        let block1_ms = samples_to_ms(480_000);
        assert_eq!(
            label_for(
                AudioChannel::System,
                Some(&diarization),
                block1_ms + 2_000,
                block1_ms + 6_000,
            ),
            "Speaker 2"
        );

        // Block 3 (60..90s), relative [3s..8s] -> track-local [63s..68s] -> Speaker 1!
        let block2_ms = samples_to_ms(960_000);
        assert_eq!(
            label_for(
                AudioChannel::System,
                Some(&diarization),
                block2_ms + 3_000,
                block2_ms + 8_000,
            ),
            "Speaker 1"
        );
    }

    #[test]
    fn channels_merge_on_one_timeline_and_renumber() {
        let merged = merge_channels(vec![
            segment(20_000, SYSTEM_CHANNEL),
            segment(5_000, MIC_CHANNEL),
            segment(5_000, SYSTEM_CHANNEL),
            segment(1_000, SYSTEM_CHANNEL),
        ]);

        let order: Vec<_> = merged
            .iter()
            .map(|segment| (segment.start_ms, segment.audio_channel.as_str()))
            .collect();
        assert_eq!(
            order,
            vec![
                (1_000, SYSTEM_CHANNEL),
                (5_000, MIC_CHANNEL),
                (5_000, SYSTEM_CHANNEL),
                (20_000, SYSTEM_CHANNEL),
            ]
        );
        assert_eq!(
            merged
                .iter()
                .map(|segment| segment.seq_no)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
    }

    #[test]
    fn streaming_wav_decoder_resamples_48k_to_16k_accurately() {
        let dir = tempfile::tempdir().unwrap();
        let wav_path = dir.path().join("sample48k.wav");
        let spec = memo_audio_capture::WavSpec::new(48_000, 1).unwrap();
        let mut writer = memo_audio_capture::WavWriter::create(&wav_path, spec).unwrap();
        let samples_48k: Vec<f32> = (0..96_000)
            .map(|i| ((i as f32 / 48_000.0) * 440.0 * std::f32::consts::TAU).sin() * 0.4)
            .collect();
        writer.write_samples(&samples_48k).unwrap();
        writer.finalize().unwrap();

        let decoded_16k = decode_16k_streaming(&wav_path).unwrap();
        assert!(
            (31_900..=32_100).contains(&decoded_16k.len()),
            "expected ~32,000 resampled frames for 2.0s @ 16 kHz, got {}",
            decoded_16k.len()
        );
        assert!(!is_silent(&decoded_16k));
    }
}
