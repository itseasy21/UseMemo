use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::events::{self, AsrSegmentDeltaPayload};
use crate::state::AppState;
use crate::storage::{NewTranscriptSegment, Speaker, TranscriptSegment};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendTranscriptInput {
    pub meeting_id: String,
    pub seq_no: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_label: String,
    #[serde(default = "default_channel")]
    pub audio_channel: String,
    pub text: String,
    #[serde(default)]
    pub is_confirmed: bool,
    #[serde(default)]
    pub is_final: bool,
}

fn default_channel() -> String {
    "mic".into()
}

#[tauri::command]
pub async fn append_transcript(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AppendTranscriptInput,
) -> AppResult<TranscriptSegment> {
    let channel = match input.audio_channel.to_ascii_lowercase().as_str() {
        "mic" | "microphone" => "mic",
        "system" | "desktop" => "system",
        other => {
            return Err(crate::error::AppError::Invalid(format!(
                "unknown audio channel: {other}"
            )))
        }
    };
    let segment = state
        .db
        .insert_transcript_segment(
            &input.meeting_id,
            NewTranscriptSegment {
                seq_no: input.seq_no,
                start_ms: input.start_ms,
                end_ms: input.end_ms,
                speaker_label: input.speaker_label.clone(),
                audio_channel: channel.into(),
                text: input.text.clone(),
                is_confirmed: input.is_confirmed,
            },
        )
        .await?;
    events::emit(
        &app,
        events::ASR_SEGMENT_DELTA,
        AsrSegmentDeltaPayload {
            meeting_id: input.meeting_id,
            seq_no: segment.seq_no,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            speaker_label: segment.speaker_label.clone(),
            text: segment.text.clone(),
            is_final: input.is_final || input.is_confirmed,
        },
    )?;
    Ok(segment)
}

/// Transcribe the meeting's recorded archive with the installed on-device model.
#[tauri::command]
pub async fn transcribe_meeting(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<crate::asr::TranscriptionOutcome> {
    crate::asr::transcribe_meeting(&app, &state, &meeting_id).await
}

#[tauri::command]
pub async fn cancel_transcription(state: State<'_, AppState>) -> AppResult<()> {
    state.request_asr_cancel();
    Ok(())
}

#[tauri::command]
pub async fn list_transcript(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<Vec<TranscriptSegment>> {
    state.db.list_transcript(&meeting_id).await
}

#[tauri::command]
pub async fn list_speakers(state: State<'_, AppState>) -> AppResult<Vec<Speaker>> {
    state.db.list_speakers().await
}

#[tauri::command]
pub async fn upsert_speaker(
    state: State<'_, AppState>,
    display_name: String,
    is_local_user: bool,
) -> AppResult<Speaker> {
    state.db.upsert_speaker(&display_name, is_local_user).await
}

#[tauri::command]
pub async fn rename_speaker(
    state: State<'_, AppState>,
    meeting_id: String,
    old_label: String,
    new_name: String,
    save_voiceprint: bool,
) -> AppResult<Speaker> {
    let speaker = state
        .db
        .rename_speaker(&meeting_id, &old_label, &new_name, save_voiceprint)
        .await?;

    if save_voiceprint && state.brand.manifest().features.enable_voiceprint_enrollment {
        if let Ok(meeting) = state.db.get_meeting(&meeting_id).await {
            if let Ok(segments) = state.db.list_transcript(&meeting_id).await {
                let target_id = speaker.id.clone();
                let matching: Vec<_> = segments
                    .into_iter()
                    .filter(|seg| seg.speaker_id.as_deref() == Some(target_id.as_str()))
                    .collect();
                if let Some(first) = matching.first() {
                    let is_system = first.audio_channel == "system";
                    let path_opt = if is_system {
                        meeting.system_audio_file_path.clone()
                    } else {
                        meeting.audio_file_path.clone()
                    };
                    let track_offset = if is_system {
                        meeting.system_audio_started_at_ms.max(0)
                    } else {
                        0
                    };
                    if let Some(wav_path) = path_opt.map(std::path::PathBuf::from) {
                        let ranges: Vec<(i64, i64)> = matching
                            .iter()
                            .map(|seg| {
                                let start = (seg.start_ms - track_offset).max(0);
                                let end = (seg.end_ms - track_offset).max(start);
                                (start, end)
                            })
                            .collect();
                        if let Ok(Some(centroid)) = tokio::task::spawn_blocking(move || {
                            crate::asr::transcribe::compute_voiceprint_for_wav(&wav_path, &ranges)
                        })
                        .await
                        {
                            if let Ok(updated) = state
                                .db
                                .set_speaker_voiceprint(&speaker.id, &centroid)
                                .await
                            {
                                return Ok(updated);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(speaker)
}

#[tauri::command]
pub async fn update_transcript_segment(
    state: State<'_, AppState>,
    segment_id: String,
    text: Option<String>,
    speaker_label: Option<String>,
) -> AppResult<TranscriptSegment> {
    state
        .db
        .update_transcript_segment(&segment_id, text.as_deref(), speaker_label.as_deref())
        .await
}
