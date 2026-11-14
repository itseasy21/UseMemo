use serde::{Deserialize, Serialize};

/// The platform's current microphone authorization state.
///
/// `Prompt` means the user has not made a choice, or Android cannot distinguish
/// a first request from a permanently denied one. Requesting again resolves the
/// real state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MicrophonePermission {
    Granted,
    Denied,
    Prompt,
    Unsupported,
}

/// Result of activating the platform audio session for a take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSessionStatus {
    pub configured: bool,
    /// `ios`, `android`, or `desktop`; useful in diagnostics and the UI.
    pub backend: String,
}

/// Result of releasing the platform audio session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSessionAck {
    pub deactivated: bool,
}

#[cfg(any(mobile, test))]
#[derive(Debug, Deserialize)]
pub(crate) struct PermissionResponse {
    pub status: MicrophonePermission,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_serializes_as_lowercase() {
        assert_eq!(
            serde_json::to_value(MicrophonePermission::Prompt).unwrap(),
            "prompt"
        );
        assert_eq!(
            serde_json::from_value::<MicrophonePermission>("granted".into()).unwrap(),
            MicrophonePermission::Granted
        );
    }

    #[test]
    fn audio_session_serializes_as_camel_case() {
        let status = AudioSessionStatus {
            configured: true,
            backend: "ios".into(),
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["configured"], true);
        assert_eq!(value["backend"], "ios");
    }

    #[test]
    fn native_permission_response_parses() {
        let response: PermissionResponse = serde_json::from_str(r#"{"status":"prompt"}"#).unwrap();
        assert_eq!(response.status, MicrophonePermission::Prompt);
    }
}
