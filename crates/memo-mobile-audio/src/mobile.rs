use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{
    AudioSessionAck, AudioSessionStatus, MicrophonePermission, PermissionResponse,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_audio);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<MobileAudio<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("org.gnu.usememo.mobileaudio", "MobileAudioPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mobile_audio)?;
    Ok(MobileAudio(handle))
}

pub struct MobileAudio<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> MobileAudio<R> {
    fn permission(&self, command: &str) -> crate::Result<MicrophonePermission> {
        self.0
            .run_mobile_plugin::<PermissionResponse>(command, ())
            .map(|response| response.status)
            .map_err(Into::into)
    }

    pub fn microphone_permission(&self) -> crate::Result<MicrophonePermission> {
        self.permission("microphonePermission")
    }

    pub fn request_microphone_permission(&self) -> crate::Result<MicrophonePermission> {
        self.permission("requestMicrophonePermission")
    }

    pub fn configure_audio_session(&self) -> crate::Result<AudioSessionStatus> {
        self.0
            .run_mobile_plugin("configureAudioSession", ())
            .map_err(Into::into)
    }

    pub fn deactivate_audio_session(&self) -> crate::Result<AudioSessionAck> {
        self.0
            .run_mobile_plugin("deactivateAudioSession", ())
            .map_err(Into::into)
    }
}
