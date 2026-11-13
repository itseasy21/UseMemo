use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::events::{self, SynthesisProgressPayload};
use crate::state::AppState;
use crate::storage::{SynthesisItem, SynthesisItemPatch};
use crate::synthesis::context::build_context;
use crate::synthesis::orchestrator::synthesize;
use crate::synthesis::types::VerificationReport;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisResponse {
    pub items: Vec<SynthesisItem>,
    pub report: VerificationReport,
    pub engine_id: String,
}

#[tauri::command]
pub async fn synthesize_meeting(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<SynthesisResponse> {
    let emit_progress = |stage: &str, percent: f32, message: Option<String>| {
        let _ = events::emit(
            &app,
            events::SYNTHESIS_PROGRESS,
            SynthesisProgressPayload {
                meeting_id: meeting_id.clone(),
                stage: stage.into(),
                percent,
                message,
            },
        );
    };
    emit_progress("context", 10.0, None);
    let meeting = state.db.get_meeting(&meeting_id).await?;
    let notes = state.db.list_note_blocks(&meeting_id).await?;
    let transcript = state.db.list_transcript(&meeting_id).await?;
    let screenshots = state.db.list_screenshots(&meeting_id).await?;
    let speakers = state.db.list_speakers().await?;
    let context = build_context(&meeting, &notes, &transcript, &screenshots, &speakers);

    emit_progress("generating", 35.0, None);
    let verified = match synthesize(&state.brand, &context, state.synthesis.as_ref()).await {
        Ok(verified) => verified,
        Err(error) => {
            emit_progress("failed", 100.0, Some(error.to_string()));
            return Err(error);
        }
    };

    emit_progress("verifying", 85.0, None);
    let engine_id = state.synthesis.engine_id().to_string();
    let report = verified.report.clone();
    let items = state
        .db
        .replace_synthesis_items(&meeting_id, verified.items)
        .await?;
    emit_progress("complete", 100.0, None);
    Ok(SynthesisResponse {
        items,
        report,
        engine_id,
    })
}

#[tauri::command]
pub async fn list_synthesis(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<Vec<SynthesisItem>> {
    state.db.list_synthesis_items(&meeting_id).await
}

#[tauri::command]
pub async fn update_synthesis_item(
    state: State<'_, AppState>,
    item_id: String,
    patch: SynthesisItemPatch,
) -> AppResult<SynthesisItem> {
    state.db.update_synthesis_item(&item_id, patch).await
}

#[tauri::command]
pub async fn synthesis_context_preview(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<String> {
    let meeting = state.db.get_meeting(&meeting_id).await?;
    let notes = state.db.list_note_blocks(&meeting_id).await?;
    let transcript = state.db.list_transcript(&meeting_id).await?;
    let screenshots = state.db.list_screenshots(&meeting_id).await?;
    let speakers = state.db.list_speakers().await?;
    Ok(build_context(&meeting, &notes, &transcript, &screenshots, &speakers).text)
}

#[tauri::command]
pub async fn export_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<crate::export::ExportOutcome> {
    let meeting = state.db.get_meeting(&meeting_id).await?;
    let notes = state.db.list_note_blocks(&meeting_id).await?;
    let transcript = state.db.list_transcript(&meeting_id).await?;
    let screenshots = state.db.list_screenshots(&meeting_id).await?;
    let synthesis = state.db.list_synthesis_items(&meeting_id).await?;
    crate::export::export_meeting(crate::export::ExportMeeting {
        brand: &state.brand,
        meeting: &meeting,
        notes: &notes,
        transcript: &transcript,
        screenshots: &screenshots,
        synthesis: &synthesis,
        vault_root: &state.paths.exports_dir,
        exported_at_ms: Utc::now().timestamp_millis(),
    })
}
