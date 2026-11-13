use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::storage::{Folder, SearchFilters, SearchHit};

#[tauri::command]
pub async fn search(
    state: State<'_, AppState>,
    query: String,
    filters: Option<SearchFilters>,
) -> AppResult<Vec<SearchHit>> {
    state.db.search(&query, filters.unwrap_or_default()).await
}

#[tauri::command]
pub async fn rebuild_search_index(state: State<'_, AppState>) -> AppResult<()> {
    state.db.rebuild_search_index().await
}

#[tauri::command]
pub async fn create_folder(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> AppResult<Folder> {
    state.db.create_folder(&name, parent_id.as_deref()).await
}

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>) -> AppResult<Vec<Folder>> {
    state.db.list_folders().await
}
