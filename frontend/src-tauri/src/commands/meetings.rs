use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::audio::{AudioCaptureSession, AudioLevelSample};
use crate::error::{AppError, AppResult};
use crate::events::{AudioLevelsPayload, RecordingStoppedPayload};
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

    // Start capture before the database claims the meeting is recording. A
    // missing or blocked microphone must fail here, not thirty minutes in.
    let audio_path = state.paths.meeting_media_dir(&meeting.id).join("audio.wav");
    let (level_tx, mut level_rx) = tokio::sync::mpsc::channel::<AudioLevelSample>(64);
    let audio = match AudioCaptureSession::start(meeting.id.clone(), audio_path, Some(level_tx)) {
        Ok(audio) => audio,
        Err(error) => {
            // Roll the meeting out of the recording state so the vault does not
            // show a phantom take that never captured anything.
            let _ = state.db.finish_meeting(&meeting.id, 0).await;
            return Err(error);
        }
    };

    let now = Utc::now().timestamp_millis();
    let scheduler = match CaptureScheduler::start(
        &state.capture_lease,
        &meeting.id,
        meeting.screenshot_interval_sec,
        now,
    ) {
        Ok(scheduler) => scheduler,
        Err(error) => {
            // Another capture already holds the lease. Stop this take and put
            // the meeting back to completed so it does not look live forever.
            drop(audio);
            let _ = state.db.finish_meeting(&meeting.id, 0).await;
            return Err(error);
        }
    };
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
        audio: Some(audio),
    });
    drop(active);

    // Forward meters to the HUD. The channel closes when the session is taken
    // out of `RecordingRuntime`, which ends this task.
    let level_app = app.clone();
    let level_meeting = meeting.id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(sample) = level_rx.recv().await {
            let payload = AudioLevelsPayload {
                meeting_id: level_meeting.clone(),
                channel: "mic".into(),
                rms_dbfs: sample.rms_dbfs,
                peak_dbfs: sample.peak_dbfs,
                at_ms: sample.at_ms,
            };
            let _ = level_app.emit(crate::events::AUDIO_LEVELS, payload);
        }
    });

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
    let wall_clock_ms = runtime
        .as_ref()
        .map(|runtime| Utc::now().timestamp_millis() - runtime.started_at_ms)
        .unwrap_or(0);
    let mut outcome = None;
    let mut failure: Option<String> = None;

    if let Some(mut runtime) = runtime {
        let _ = runtime.cancel.send(true);
        if let Some(audio) = runtime.audio.take() {
            // Joining the writer can take a few hundred milliseconds; keep it
            // off the async runtime's threads.
            match tokio::task::spawn_blocking(move || audio.stop()).await {
                Ok(Ok(finished)) => outcome = Some(finished),
                Ok(Err(error)) => failure = Some(error.to_string()),
                Err(error) => failure = Some(format!("audio finalize task failed: {error}")),
            }
        }
    }

    if let Some(finished) = outcome.as_ref() {
        if let Err(error) = state
            .db
            .set_audio_file_path(&meeting_id, &finished.path_string())
            .await
        {
            failure.get_or_insert_with(|| error.to_string());
        }
    }

    // Trust the audio clock when we have one: it is derived from samples, so it
    // does not drift with scheduler stalls. A second stop on an already
    // finalized meeting must not erase its duration.
    let existing_duration = state.db.get_meeting(&meeting_id).await?.duration_ms;
    let duration = outcome
        .as_ref()
        .map(|finished| finished.duration_ms)
        .filter(|duration| *duration > 0)
        .or_else(|| (wall_clock_ms > 0).then_some(wall_clock_ms))
        .unwrap_or(existing_duration);
    let meeting = state.db.finish_meeting(&meeting_id, duration).await?;

    let stopped = RecordingStoppedPayload {
        meeting_id: meeting_id.clone(),
        duration_ms: meeting.duration_ms,
        path: outcome.as_ref().map(|finished| finished.path_string()),
        silent: outcome.as_ref().is_some_and(|finished| finished.silent),
        dropped_blocks: outcome
            .as_ref()
            .map(|finished| finished.dropped_blocks)
            .unwrap_or(0),
        peak_dbfs: outcome
            .as_ref()
            .map(|finished| finished.peak_dbfs)
            .unwrap_or(-120.0),
        error: failure,
    };
    let _ = crate::events::emit(&app, crate::events::RECORDING_STOPPED, stopped);

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
