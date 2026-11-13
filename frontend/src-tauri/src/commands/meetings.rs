use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::screenshot::policy::CaptureScheduler;
use crate::state::{AppState, RecordingRuntime, RecordingSnapshot};
use crate::storage::{CreateMeetingInput, Meeting};

#[tauri::command]
pub async fn create_meeting(
    state: State<'_, AppState>,
    input: CreateMeetingInput,
) -> AppResult<Meeting> {
    state.db.create_meeting(input).await
}

#[tauri::command]
pub async fn list_meetings(state: State<'_, AppState>) -> AppResult<Vec<Meeting>> {
    state.db.list_meetings().await
}

#[tauri::command]
pub async fn get_meeting(state: State<'_, AppState>, meeting_id: String) -> AppResult<Meeting> {
    state.db.get_meeting(&meeting_id).await
}

#[tauri::command]
pub async fn finish_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
    duration_ms: i64,
) -> AppResult<Meeting> {
    state.db.finish_meeting(&meeting_id, duration_ms).await
}

#[tauri::command]
pub async fn delete_meeting(state: State<'_, AppState>, meeting_id: String) -> AppResult<()> {
    state.db.delete_meeting(&meeting_id).await?;
    let media = state.paths.meeting_media_dir(&meeting_id);
    if media.exists() {
        std::fs::remove_dir_all(media)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_meeting_starred(
    state: State<'_, AppState>,
    meeting_id: String,
    starred: bool,
) -> AppResult<()> {
    state.db.set_meeting_starred(&meeting_id, starred).await
}

#[tauri::command]
pub async fn set_screenshot_interval(
    state: State<'_, AppState>,
    meeting_id: String,
    interval_sec: i64,
) -> AppResult<()> {
    state
        .db
        .set_screenshot_interval(&meeting_id, interval_sec)
        .await
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<Meeting> {
    let mut active = state.recording.lock().await;
    if let Some(runtime) = active.as_ref() {
        return Err(AppError::Capture(format!(
            "a recording is already active for meeting {}",
            runtime.meeting_id
        )));
    }

    let meeting = state.db.get_meeting(&meeting_id).await?;
    let now = Utc::now().timestamp_millis();
    let scheduler = CaptureScheduler::start(
        &state.capture_lease,
        &meeting.id,
        meeting.screenshot_interval_sec,
        now,
    )?;
    state
        .db
        .set_meeting_status(&meeting.id, "recording")
        .await?;
    let scheduler = Arc::new(Mutex::new(scheduler));
    let (cancel, cancel_rx) = tokio::sync::watch::channel(false);
    *active = Some(RecordingRuntime {
        meeting_id: meeting.id.clone(),
        started_at_ms: now,
        interval_sec: meeting.screenshot_interval_sec,
        cancel,
        scheduler: Arc::clone(&scheduler),
    });
    drop(active);

    if meeting.screenshot_interval_sec > 0 {
        let app_handle = app.clone();
        let started_at = now;
        let mut cancel_rx = cancel_rx;
        let task_scheduler = Arc::clone(&scheduler);
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(
                meeting.screenshot_interval_sec.max(1) as u64,
            ));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let now = Utc::now().timestamp_millis();
                        let state = app_handle.state::<AppState>();
                        let mut session = task_scheduler.lock().await;
                        match super::screenshots::capture_once(
                            &state,
                            &mut session,
                            "interval",
                            now,
                            started_at,
                        ).await {
                            Ok(payload) => {
                                let _ = crate::events::screenshot_event(&app_handle, payload);
                            }
                            Err(error) => {
                                eprintln!("automatic screenshot failed: {error}");
                            }
                        }
                    }
                    changed = cancel_rx.changed() => {
                        if changed.is_err() || *cancel_rx.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }

    app.emit(
        "meeting:changed",
        crate::events::MeetingChangedPayload {
            meeting: meeting.clone(),
        },
    )
    .map_err(|error| AppError::Invalid(format!("cannot emit meeting change: {error}")))?;
    Ok(meeting)
}

#[tauri::command]
pub async fn stop_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<Meeting> {
    let runtime = {
        let mut active = state.recording.lock().await;
        match active.as_ref() {
            Some(runtime) if runtime.meeting_id == meeting_id => active.take(),
            Some(runtime) => {
                return Err(AppError::Capture(format!(
                    "meeting {} is recording, not {meeting_id}",
                    runtime.meeting_id
                )))
            }
            None => None,
        }
    };
    let duration = runtime
        .as_ref()
        .map(|runtime| Utc::now().timestamp_millis() - runtime.started_at_ms)
        .unwrap_or(0);
    if let Some(runtime) = runtime {
        let _ = runtime.cancel.send(true);
    }
    let meeting = state.db.finish_meeting(&meeting_id, duration).await?;
    app.emit(
        "meeting:changed",
        crate::events::MeetingChangedPayload {
            meeting: meeting.clone(),
        },
    )
    .map_err(|error| AppError::Invalid(format!("cannot emit meeting change: {error}")))?;
    Ok(meeting)
}

#[tauri::command]
pub async fn recording_status(state: State<'_, AppState>) -> AppResult<Option<RecordingSnapshot>> {
    Ok(state.recording_snapshot().await)
}
