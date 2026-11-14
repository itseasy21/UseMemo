use tauri::{command, AppHandle, Runtime};

use crate::models::{AudioSessionAck, AudioSessionStatus, MicrophonePermission};
use crate::{MobileAudioExt, Result};

#[command]
pub(crate) async fn microphone_permission<R: Runtime>(
    app: AppHandle<R>,
) -> Result<MicrophonePermission> {
    app.mobile_audio().microphone_permission()
}

#[command]
pub(crate) async fn request_microphone_permission<R: Runtime>(
    app: AppHandle<R>,
) -> Result<MicrophonePermission> {
    app.mobile_audio().request_microphone_permission()
}

#[command]
pub(crate) async fn configure_audio_session<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AudioSessionStatus> {
    app.mobile_audio().configure_audio_session()
}

#[command]
pub(crate) async fn deactivate_audio_session<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AudioSessionAck> {
    app.mobile_audio().deactivate_audio_session()
}
