//! Meeting-level transcription: decode, block, recognize, persist.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::asr::engine::{block_ranges, clean_text, is_silent, AsrEngine, BLOCK_MS};
use crate::error::{AppError, AppResult};
use crate::events::{AsrProgressPayload, AsrSegmentDeltaPayload, MeetingChangedPayload};
#[cfg(feature = "asr")]
use crate::model_registry::{catalog, HardwareProfile, ModelRole};
use crate::state::AppState;
use crate::storage::NewTranscriptSegment;

/// Speaker label for microphone audio. Diarization is not wired yet, so every
/// microphone segment is attributed to the local user rather than guessed at.
const MIC_LABEL: &str = "You";
const MIC_CHANNEL: &str = "mic";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOutcome {
    pub engine_id: String,
    pub model_id: String,
    pub segments: usize,
    pub blocks: usize,
    pub skipped_blocks: usize,
    pub duration_ms: i64,
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
    let path = meeting
        .audio_file_path
        .clone()
        .ok_or_else(|| AppError::Asr("this meeting has no recorded audio".into()))?;

    // Prefer the sample clock in the file; fall back to the stored duration.
    let fallback_duration = meeting.duration_ms;

    state
        .db
        .set_meeting_status(meeting_id, "processing")
        .await?;
    let _ = emit_progress(app, meeting_id, "loading", 0.0, 0, 0, 0);

    let result = run(app, state, meeting_id, &path, &meeting.asr_model_id).await;
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
    path: &str,
    preferred_model: &str,
) -> AppResult<TranscriptionOutcome> {
    let path = PathBuf::from(path);
    let samples = tokio::task::spawn_blocking(move || decode_16k(&path))
        .await
        .map_err(|error| AppError::Asr(format!("decode task failed: {error}")))??;

    let duration_ms = (samples.len() as i128 * 1_000 / 16_000) as i64;
    let engine = engine_for(state, preferred_model).await?;

    let ranges = block_ranges(samples.len(), (16_000 * BLOCK_MS / 1_000) as usize);
    let mut pending: Vec<NewTranscriptSegment> = Vec::new();
    let mut skipped_blocks = 0usize;
    let mut blocks = 0usize;

    for (index, (start, end)) in ranges.iter().enumerate() {
        let block = &samples[*start..*end];
        let offset_ms = (*start as i128 * 1_000 / 16_000) as i64;

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
                let start_ms = offset_ms + segment.start_ms.max(0);
                let end_ms = (offset_ms + segment.end_ms).max(start_ms);
                pending.push(NewTranscriptSegment {
                    seq_no: pending.len() as i64 + 1,
                    start_ms,
                    end_ms,
                    speaker_label: MIC_LABEL.into(),
                    audio_channel: MIC_CHANNEL.into(),
                    text,
                    is_confirmed: true,
                });
            }
        }

        let processed_ms = (*end as i128 * 1_000 / 16_000) as i64;
        let percent = ((index + 1) as f32 / ranges.len() as f32) * 100.0;
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

    // Swap the transcript in one transaction only after every block decoded.
    // A failure above leaves the previous transcript untouched.
    let stored = state.db.replace_transcript(meeting_id, pending).await?;
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
        duration_ms,
    })
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
            duration_ms: 90_000,
        };
        let value = serde_json::to_value(outcome).unwrap();
        assert_eq!(value["engineId"], "whisper-rs");
        assert_eq!(value["skippedBlocks"], 1);
    }
}
