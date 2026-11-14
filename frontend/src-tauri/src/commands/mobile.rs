use memo_mobile_audio::{
    AudioSessionAck, AudioSessionStatus, MicrophonePermission, MobileAudioExt,
};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

fn plugin_error(error: memo_mobile_audio::Error) -> AppError {
    AppError::Capture(error.to_string())
}

/// Current microphone authorization. Desktop always reports `granted` because
/// its capture backend prompts directly.
#[tauri::command]
pub async fn microphone_permission(app: AppHandle) -> AppResult<MicrophonePermission> {
    app.mobile_audio()
        .microphone_permission()
        .map_err(plugin_error)
}

/// Show the native microphone consent prompt when the platform requires one.
#[tauri::command]
pub async fn request_microphone_permission(app: AppHandle) -> AppResult<MicrophonePermission> {
    app.mobile_audio()
        .request_microphone_permission()
        .map_err(plugin_error)
}

/// Activate the platform audio session before opening the capture backend.
#[tauri::command]
pub async fn configure_audio_session(app: AppHandle) -> AppResult<AudioSessionStatus> {
    app.mobile_audio()
        .configure_audio_session()
        .map_err(plugin_error)
}

/// Release audio focus or the iOS audio session after the take.
#[tauri::command]
pub async fn deactivate_audio_session(app: AppHandle) -> AppResult<AudioSessionAck> {
    app.mobile_audio()
        .deactivate_audio_session()
        .map_err(plugin_error)
}
