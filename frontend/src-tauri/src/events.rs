//! Typed Tauri event contract shared with the frontend.
//!
//! Event names are stable and namespaced with a colon. Payloads are camelCase
//! so the TypeScript hooks in `frontend/src/lib/events.ts` can mirror them
//! without a conversion layer.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::screenshot::dhash::hash_to_hex;
use crate::storage::{Meeting, Screenshot};

pub const AUDIO_LEVELS: &str = "audio:levels";
pub const ASR_SEGMENT_DELTA: &str = "asr:segment-delta";
pub const ASR_PROGRESS: &str = "asr:progress";
pub const SCREENSHOT_CAPTURED: &str = "screenshot:captured";
pub const SYNTHESIS_PROGRESS: &str = "synthesis:progress";
pub const MODELS_DOWNLOAD_PROGRESS: &str = "models:download-progress";
pub const MEETING_CHANGED: &str = "meeting:changed";
pub const RECORDING_STOPPED: &str = "recording:stopped";

pub const ALL: &[&str] = &[
    AUDIO_LEVELS,
    ASR_SEGMENT_DELTA,
    ASR_PROGRESS,
    SCREENSHOT_CAPTURED,
    SYNTHESIS_PROGRESS,
    MODELS_DOWNLOAD_PROGRESS,
    MEETING_CHANGED,
    RECORDING_STOPPED,
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevelsPayload {
    pub meeting_id: String,
    pub channel: String,
    pub rms_dbfs: f32,
    pub peak_dbfs: f32,
    pub at_ms: i64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub echo_bleed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrSegmentDeltaPayload {
    pub meeting_id: String,
    pub seq_no: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_label: String,
    pub text: String,
    pub is_final: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrProgressPayload {
    pub meeting_id: String,
    pub stage: String,
    pub percent: f32,
    pub segments: usize,
    pub processed_ms: i64,
    pub total_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotCapturedPayload {
    pub meeting_id: String,
    pub screenshot: Option<Screenshot>,
    pub deduplicated: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisProgressPayload {
    pub meeting_id: String,
    pub stage: String,
    pub percent: f32,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingChangedPayload {
    pub meeting: Meeting,
}

/// Facts about the system-audio archive. Kept nested so the microphone fields
/// above remain the primary contract for older callers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioFacts {
    pub path: String,
    pub started_at_ms: i64,
    pub duration_ms: i64,
    pub silent: bool,
    pub dropped_blocks: u64,
    pub peak_dbfs: f32,
    /// A stream error that truncated the archive. The file is still playable.
    pub error: Option<String>,
}

/// Emitted when a take is finalized. Carries the facts the UI needs to tell the
/// user whether the recording is actually usable, which the `Meeting` row alone
/// cannot express.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStoppedPayload {
    pub meeting_id: String,
    pub duration_ms: i64,
    pub path: Option<String>,
    pub silent: bool,
    pub dropped_blocks: u64,
    pub peak_dbfs: f32,
    pub system: Option<SystemAudioFacts>,
    /// Set when the loopback tap failed before it could produce an archive.
    pub system_error: Option<String>,
    pub error: Option<String>,
}

impl ScreenshotCapturedPayload {
    pub fn captured(meeting_id: impl Into<String>, screenshot: Screenshot) -> Self {
        Self {
            meeting_id: meeting_id.into(),
            screenshot: Some(screenshot),
            deduplicated: false,
            reason: "captured".into(),
        }
    }

    pub fn duplicate(meeting_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            meeting_id: meeting_id.into(),
            screenshot: None,
            deduplicated: true,
            reason: reason.into(),
        }
    }

    pub fn skipped(meeting_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            meeting_id: meeting_id.into(),
            screenshot: None,
            deduplicated: false,
            reason: reason.into(),
        }
    }
}

pub fn emit<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) -> AppResult<()> {
    app.emit(event, payload)
        .map_err(|error| AppError::Invalid(format!("cannot emit {event}: {error}")))
}

pub fn screenshot_event(app: &AppHandle, payload: ScreenshotCapturedPayload) -> AppResult<()> {
    emit(app, SCREENSHOT_CAPTURED, payload)
}

pub fn hash_hex(hash: u64) -> String {
    hash_to_hex(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_are_stable_and_unique() {
        assert_eq!(AUDIO_LEVELS, "audio:levels");
        assert_eq!(ASR_SEGMENT_DELTA, "asr:segment-delta");
        assert_eq!(ASR_PROGRESS, "asr:progress");
        assert_eq!(SCREENSHOT_CAPTURED, "screenshot:captured");
        assert_eq!(SYNTHESIS_PROGRESS, "synthesis:progress");
        assert_eq!(MODELS_DOWNLOAD_PROGRESS, "models:download-progress");
        assert_eq!(MEETING_CHANGED, "meeting:changed");
        assert_eq!(RECORDING_STOPPED, "recording:stopped");
        let unique: std::collections::BTreeSet<&str> = ALL.iter().copied().collect();
        assert_eq!(unique.len(), ALL.len());
        assert!(ALL.iter().all(|name| name.contains(':')));
    }

    #[test]
    fn payloads_serialize_as_camel_case() {
        let payload = AudioLevelsPayload {
            meeting_id: "m".into(),
            channel: "mixed".into(),
            rms_dbfs: -24.0,
            peak_dbfs: -12.0,
            at_ms: 1_500,
            echo_bleed: false,
            device_error: None,
        };
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["meetingId"], "m");
        assert_eq!(value["rmsDbfs"], -24.0);
        assert_eq!(value["atMs"], 1_500);

        let screenshot = ScreenshotCapturedPayload::duplicate("m", "near-duplicate");
        let value = serde_json::to_value(screenshot).unwrap();
        assert_eq!(value["deduplicated"], true);
        assert_eq!(value["screenshot"], serde_json::Value::Null);
    }

    #[test]
    fn synthesis_progress_carries_bounded_percent() {
        let payload = SynthesisProgressPayload {
            meeting_id: "m".into(),
            stage: "verifying".into(),
            percent: 80.0,
            message: None,
        };
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["stage"], "verifying");
        assert_eq!(value["percent"], 80.0);
    }
}
