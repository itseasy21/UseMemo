use serde::Deserialize;
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::storage::{NewNoteBlock, NoteBlock};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNotesInput {
    pub meeting_id: String,
    #[serde(default)]
    pub raw_md: String,
    pub blocks: Vec<NewNoteBlock>,
}

#[tauri::command]
pub async fn save_notes(
    state: State<'_, AppState>,
    input: SaveNotesInput,
) -> AppResult<Vec<NoteBlock>> {
    state
        .db
        .save_note_blocks(&input.meeting_id, &input.raw_md, input.blocks)
        .await
}

#[tauri::command]
pub async fn list_notes(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<Vec<NoteBlock>> {
    state.db.list_note_blocks(&meeting_id).await
}
