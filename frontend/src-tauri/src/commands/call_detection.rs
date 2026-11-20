use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::call_detection::{self, CallDetectionState, CallDetectionStatus};
use crate::error::AppResult;

#[tauri::command]
pub fn call_detection_status(state: State<'_, Arc<CallDetectionState>>) -> CallDetectionStatus {
    call_detection::status(state.inner().as_ref())
}

#[tauri::command]
pub fn set_call_detection_enabled(
    app: AppHandle,
    state: State<'_, Arc<CallDetectionState>>,
    enabled: bool,
) -> AppResult<CallDetectionStatus> {
    state
        .set_enabled(enabled)
        .map_err(crate::error::AppError::Invalid)?;
    let status = call_detection::status(state.inner().as_ref());
    let _ = app.emit("call-detect://settings-changed", status.clone());
    if !enabled {
        let _ = app.emit(
            "call-detect://dismissed",
            serde_json::json!({ "callId": null }),
        );
    }
    Ok(status)
}

#[tauri::command]
pub fn set_call_detection_app_enabled(
    app: AppHandle,
    state: State<'_, Arc<CallDetectionState>>,
    app_id: String,
    enabled: bool,
) -> AppResult<CallDetectionStatus> {
    state
        .set_app_enabled(app_id, enabled)
        .map_err(crate::error::AppError::Invalid)?;
    let status = call_detection::status(state.inner().as_ref());
    let _ = app.emit("call-detect://settings-changed", status.clone());
    Ok(status)
}

#[tauri::command]
pub fn reset_call_detection_apps(
    app: AppHandle,
    state: State<'_, Arc<CallDetectionState>>,
) -> AppResult<CallDetectionStatus> {
    state
        .reset_disabled_apps()
        .map_err(crate::error::AppError::Invalid)?;
    let status = call_detection::status(state.inner().as_ref());
    let _ = app.emit("call-detect://settings-changed", status.clone());
    Ok(status)
}
