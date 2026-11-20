use std::sync::Arc;

use tauri::State;

use crate::call_detection::{self, CallDetectionState, CallDetectionStatus};
use crate::error::AppResult;

#[tauri::command]
pub fn call_detection_status(state: State<'_, Arc<CallDetectionState>>) -> CallDetectionStatus {
    call_detection::status(state.inner().as_ref())
}

#[tauri::command]
pub async fn set_call_detection_enabled(
    state: State<'_, Arc<CallDetectionState>>,
    enabled: bool,
) -> AppResult<CallDetectionStatus> {
    state
        .set_enabled(enabled)
        .await
        .map_err(crate::error::AppError::Invalid)?;
    Ok(call_detection::status(state.inner().as_ref()))
}

#[tauri::command]
pub async fn set_call_detection_app_enabled(
    state: State<'_, Arc<CallDetectionState>>,
    app_id: String,
    enabled: bool,
) -> AppResult<()> {
    state
        .set_app_enabled(app_id, enabled)
        .await
        .map_err(crate::error::AppError::Invalid)?;
    Ok(())
}
