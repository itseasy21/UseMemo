use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{AudioSessionAck, AudioSessionStatus, MicrophonePermission};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<MobileAudio<R>> {
    Ok(MobileAudio(PhantomData))
}

/// Desktop capture prompts on first use and reports a stream error, so the
/// permission façade has nothing to ask and the audio session is a no-op.
pub struct MobileAudio<R: Runtime>(PhantomData<fn() -> R>);

impl<R: Runtime> MobileAudio<R> {
    pub fn microphone_permission(&self) -> crate::Result<MicrophonePermission> {
        Ok(permission_status())
    }

    pub fn request_microphone_permission(&self) -> crate::Result<MicrophonePermission> {
        Ok(permission_status())
    }

    pub fn configure_audio_session(&self) -> crate::Result<AudioSessionStatus> {
        Ok(session_status())
    }

    pub fn deactivate_audio_session(&self) -> crate::Result<AudioSessionAck> {
        Ok(deactivation_ack())
    }
}

fn permission_status() -> MicrophonePermission {
    MicrophonePermission::Granted
}

fn session_status() -> AudioSessionStatus {
    AudioSessionStatus {
        configured: true,
        backend: "desktop".into(),
    }
}

fn deactivation_ack() -> AudioSessionAck {
    AudioSessionAck { deactivated: true }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_permission_is_granted() {
        assert_eq!(permission_status(), MicrophonePermission::Granted);
    }

    #[test]
    fn desktop_session_is_a_no_op() {
        let status = session_status();
        assert!(status.configured);
        assert_eq!(status.backend, "desktop");
        assert!(deactivation_ack().deactivated);
    }
}
