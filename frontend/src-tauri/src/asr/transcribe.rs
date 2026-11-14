//! Meeting-level transcription: decode, block, recognize, persist.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use memo_diarize::{diarize, speaker_at, Diarization, DiarizationConfig};
use tauri::{AppHandle, Emitter};

use crate::asr::engine::{block_ranges, clean_text, is_silent, AsrEngine, BLOCK_MS};
use crate::audio::AudioChannel;
use crate::error::{AppError, AppResult};
use crate::events::{AsrProgressPayload, AsrSegmentDeltaPayload, MeetingChangedPayload};
#[cfg(feature = "asr")]
use crate::model_registry::{catalog, HardwareProfile, ModelRole};
use crate::state::AppState;
use crate::storage::NewTranscriptSegment;

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
/// must never strand a take in `processing` when the audio is perfectly intact.
pub async fn transcribe_meeting(
    app: &AppHandle,
    state: &AppState,
    meeting_id: &str,
) -> AppResult<TranscriptionOutcome> {
    let _serial = state.transcribing.lock().await;
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

    // Prefer the sample clock in the files; fall back to the stored duration.
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
    )
    .await;
    let duration = result
        .as_ref()
        .map(|outcome| outcome.duration_ms)
        .unwrap_or(fallback_duration);

    // Always land the meeting back in `completed`: the audio is safe even when
    // recognition fails, and a stuck `processing` row is worse than a retry.
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
            let _ = emit_progress(app, meeting_id, "failed", 100.0, 0, duration, duration);
            eprintln!("transcription failed for {meeting_id}: {error}");
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
) -> AppResult<TranscriptionOutcome> {
    let mut tracks = Vec::with_capacity(sources.len());
    for source in sources {
        let path = source.path.clone();
        let samples = tokio::task::spawn_blocking(move || decode_16k(&path))
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

    let ranges_per_track: Vec<_> = tracks
        .iter()
        .map(|track| block_ranges(track.samples.len(), (16_000 * BLOCK_MS / 1_000) as usize))
        .collect();
    let total_ranges: usize = ranges_per_track.iter().map(Vec::len).sum();
    let mut processed_ranges = 0usize;
    let mut processed_ms = 0i64;

    let mut pending: Vec<NewTranscriptSegment> = Vec::new();
    let mut skipped_blocks = 0usize;
    let mut blocks = 0usize;

    for (track, ranges) in tracks.iter().zip(ranges_per_track.iter()) {
        let channel = match track.channel {
            AudioChannel::Microphone => MIC_CHANNEL,
            AudioChannel::System => SYSTEM_CHANNEL,
        };

        // Diarization is post-hoc and only meaningful for the loopback. The
        // microphone is the local user by construction.
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

        for (start, end) in ranges {
            let block = &track.samples[*start..*end];
            let offset_ms = track.offset_ms + samples_to_ms(*start);

            if is_silent(block) {
                skipped_blocks += 1;
            } else {
                blocks += 1;
                let engine = Arc::clone(&engine);
                let owned = block.to_vec();
                let segments = tokio::task::spawn_blocking(move || engine.transcribe(&owned, None))
                    .await
                    .map_err(|error| AppError::Asr(format!("inference task failed: {error}")))??;

                for segment in segments {
                    let Some(text) = clean_text(&segment.text) else {
                        continue;
                    };
                    let relative_start = segment.start_ms.max(0);
                    let start_ms = offset_ms + relative_start;
                    let end_ms = (offset_ms + segment.end_ms).max(start_ms);
                    pending.push(NewTranscriptSegment {
                        seq_no: 0,
                        start_ms,
                        end_ms,
                        speaker_label: label_for(
                            track.channel,
                            diarization.as_ref(),
                            relative_start,
                            segment.end_ms.max(relative_start),
                        ),
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

    // Both channels share one timeline, so renumber after the merge instead of
    // numbering each archive independently.
    let pending = merge_channels(pending);

    // Swap the transcript in one transaction only after every block decoded.
    // A failure above leaves the previous transcript untouched.
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

/// Return a cached engine, loading the installed model on first use.
async fn engine_for(state: &AppState, preferred_model: &str) -> AppResult<Arc<dyn AsrEngine>> {
    let mut cache = state.asr.lock().await;
    if let Some((model_id, engine)) = cache.as_ref() {
        if model_id == preferred_model {
            return Ok(Arc::clone(engine));
        }
    }

    let registry = state.brand.manifest().model_registry.clone();
    let models_dir = state.paths.models_dir.clone();
    let preferred = preferred_model.to_string();
    let engine =
        tokio::task::spawn_blocking(move || load_engine(&registry, &models_dir, &preferred))
            .await
            .map_err(|error| AppError::Asr(format!("model load task failed: {error}")))??;

    *cache = Some((preferred_model.to_string(), Arc::clone(&engine)));
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

/// A build without the `asr` feature has no inference backend. Fail with an
/// actionable message instead of claiming the audio was transcribed.
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

fn decode_16k(path: &Path) -> AppResult<Vec<f32>> {
    let audio = memo_audio_capture::wav::read_wav(path)
        .map_err(|error| AppError::Asr(error.to_string()))?;
    if audio.sample_rate == 16_000 {
        return Ok(audio.samples);
    }
    let mut resampler = memo_audio_capture::SincResampler::new(audio.sample_rate, 16_000)
        .map_err(|error| AppError::Asr(error.to_string()))?;
    let mut out = Vec::new();
    resampler.process(&audio.samples, &mut out);
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
            engine_id: "whisper-rs".into(),
            model_id: "whisper-small".into(),
            segments: 12,
            blocks: 3,
            skipped_blocks: 1,
            channels: 2,
            speaker_count: 3,
            duration_ms: 90_000,
        };
        let value = serde_json::to_value(outcome).unwrap();
        assert_eq!(value["engineId"], "whisper-rs");
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
    fn late_system_archive_is_offset_onto_the_meeting_clock() {
        assert_eq!(samples_to_ms(16_000), 1_000);
        let offset_ms = 2_500;
        let start = offset_ms + samples_to_ms(16_000);
        assert_eq!(start, 3_500);
    }
}
