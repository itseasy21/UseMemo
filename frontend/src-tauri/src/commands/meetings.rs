use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::audio::{
    request_system_audio_permission, session::ARCHIVE_SAMPLE_RATE, system_audio_backend,
    system_audio_permission_granted, system_audio_supported, AudioCaptureOutcome,
    AudioCaptureSession, AudioCaptureTake, AudioLevelSample,
};
use crate::error::{AppError, AppResult};
use crate::events::{AudioLevelsPayload, RecordingStoppedPayload, SystemAudioFacts};
use crate::screenshot::capture::{CaptureTarget, VisualCaptureTarget};
use crate::screenshot::policy::{CaptureScheduler, ScreenshotPolicy};
use crate::state::{AppState, RecordingRuntime, RecordingSnapshot};
use crate::storage::{CreateMeetingInput, Meeting, UpdateMeetingPatch};

#[tauri::command]
pub async fn create_meeting(
    state: State<'_, AppState>,
    input: CreateMeetingInput,
) -> AppResult<Meeting> {
    state.db.create_meeting(input).await
}

#[tauri::command]
pub async fn update_meeting(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    patch: UpdateMeetingPatch,
) -> AppResult<Meeting> {
    let meeting = state.db.update_meeting(&meeting_id, patch).await?;
    let _ = app.emit(
        crate::events::MEETING_CHANGED,
        crate::events::MeetingChangedPayload {
            meeting: meeting.clone(),
        },
    );
    Ok(meeting)
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
    {
        let active = state.recording.lock().await;
        if active
            .as_ref()
            .is_some_and(|runtime| runtime.meeting_id == meeting_id)
        {
            return Err(AppError::Capture(
                "stop the active recording before deleting this meeting".into(),
            ));
        }
    }
    state.db.delete_meeting(&meeting_id).await?;
    let media = state.paths.meeting_media_dir(&meeting_id);
    let exports_meetings_dir = state.paths.exports_dir.join("meetings");
    let short_suffix = format!(
        "-{}",
        meeting_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(8)
            .collect::<String>()
            .to_ascii_lowercase()
    );
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        if media.exists() {
            std::fs::remove_dir_all(&media)?;
        }
        if short_suffix.len() > 1 && exports_meetings_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&exports_meetings_dir) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().ends_with(&short_suffix) {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| AppError::Invalid(format!("delete cleanup task failed: {error}")))??;

    tracing::info!(meeting_id = %meeting_id, "deleted meeting and associated media/exports");
    Ok(())
}

#[tauri::command]
pub async fn set_meeting_starred(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    starred: bool,
) -> AppResult<Meeting> {
    state.db.set_meeting_starred(&meeting_id, starred).await?;
    let meeting = state.db.get_meeting(&meeting_id).await?;
    let _ = app.emit(
        crate::events::MEETING_CHANGED,
        crate::events::MeetingChangedPayload {
            meeting: meeting.clone(),
        },
    );
    Ok(meeting)
}

#[tauri::command]
pub async fn set_meeting_tags(
    state: State<'_, AppState>,
    meeting_id: String,
    tags: Vec<String>,
) -> AppResult<Vec<String>> {
    state.db.set_meeting_tags(&meeting_id, tags).await
}

#[tauri::command]
pub async fn get_meeting_tags(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<Vec<String>> {
    state.db.get_meeting_tags(&meeting_id).await
}

#[tauri::command]
pub async fn list_all_tags(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    state.db.list_all_tags().await
}

#[tauri::command]
pub async fn set_screenshot_interval(
    state: State<'_, AppState>,
    meeting_id: String,
    interval_sec: i64,
) -> AppResult<()> {
    let policy = ScreenshotPolicy::new(interval_sec)?;
    state
        .db
        .set_screenshot_interval(&meeting_id, interval_sec)
        .await?;

    let effective_interval = if state.brand.manifest().features.enable_periodic_screenshots {
        interval_sec
    } else {
        0
    };
    let mut active = state.recording.lock().await;
    if let Some(runtime) = active
        .as_mut()
        .filter(|runtime| runtime.meeting_id == meeting_id)
    {
        runtime.interval_sec = effective_interval;
        {
            let mut sched = runtime.scheduler.lock().await;
            sched.session_mut().policy = if effective_interval == 0 {
                ScreenshotPolicy::new(0)?
            } else {
                policy
            };
        }
        let _ = runtime.interval_tx.send(effective_interval);
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTargetsResponse {
    pub microphones: Vec<String>,
    pub visual_targets: Vec<VisualCaptureTarget>,
    pub active_target: CaptureTarget,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingOutcome {
    pub meeting: Meeting,
    pub system_audio_warning: Option<String>,
}

#[tauri::command]
pub async fn list_capture_targets(state: State<'_, AppState>) -> AppResult<CaptureTargetsResponse> {
    let capture = Arc::clone(&state.capture);
    let active_target = capture.target();
    let (microphones, visual_targets) = tokio::task::spawn_blocking(move || {
        let mics = memo_audio_capture::microphone::list_input_devices().unwrap_or_default();
        let visuals = capture.list_targets().unwrap_or_default();
        (mics, visuals)
    })
    .await
    .map_err(|error| AppError::Capture(format!("device enumeration panicked: {error}")))?;

    Ok(CaptureTargetsResponse {
        microphones,
        visual_targets,
        active_target,
    })
}

#[tauri::command]
pub fn set_capture_target(
    state: State<'_, AppState>,
    target: CaptureTarget,
) -> AppResult<CaptureTarget> {
    state.capture.set_target(target);
    Ok(state.capture.target())
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    capture_system_audio: Option<bool>,
    microphone_device: Option<String>,
    capture_target: Option<CaptureTarget>,
) -> AppResult<StartRecordingOutcome> {
    let mut active = state.recording.lock().await;
    if let Some(runtime) = active.as_ref() {
        return Err(AppError::Capture(format!(
            "a recording is already active for meeting {}",
            runtime.meeting_id
        )));
    }

    if let Some(target) = capture_target {
        state.capture.set_target(target);
    }

    let meeting = state.db.get_meeting(&meeting_id).await?;
    let want_system = capture_system_audio.unwrap_or(false);
    let system_supported = system_audio_supported();
    let requested_system_warning = (want_system && !system_supported).then(|| {
        "Meeting audio is not supported on this platform yet. Your microphone is still recording."
            .to_string()
    });
    let capture_system = want_system && system_supported;

    let media_dir = state.paths.meeting_media_dir(&meeting.id);
    let audio_path = media_dir.join("audio.wav");
    let system_path = capture_system.then(|| media_dir.join("audio-system.wav"));
    let (level_tx, mut level_rx) = tokio::sync::mpsc::channel::<AudioLevelSample>(64);

    let start_meeting_id = meeting.id.clone();
    let start_audio_path = audio_path.clone();
    let start_system_path = system_path.clone();
    let mic_hint = microphone_device
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    let audio = match tokio::task::spawn_blocking(move || {
        AudioCaptureSession::start_with_device(
            start_meeting_id,
            start_audio_path,
            start_system_path,
            mic_hint.as_deref(),
            Some(level_tx),
        )
    })
    .await
    {
        Ok(Ok(audio)) => audio,
        Ok(Err(error)) => {
            tracing::warn!(meeting_id = %meeting.id, error = %error, "recording startup failed");
            cleanup_failed_start(&state, &meeting.id, &media_dir).await;
            return Err(error);
        }
        Err(join_error) => {
            tracing::warn!(meeting_id = %meeting.id, error = %join_error, "audio startup task panicked");
            cleanup_failed_start(&state, &meeting.id, &media_dir).await;
            return Err(AppError::Capture(format!(
                "audio startup task panicked: {join_error}"
            )));
        }
    };
    let system_audio_warning =
        requested_system_warning.or_else(|| audio.system_start_error().map(str::to_string));
    let system_started = audio.system_device().is_some();

    // The microphone writer starts before optional loopback setup. Anchor the
    // shared meeting timeline to that earlier instant so screenshots, notes,
    // captions, and both WAVs use the same zero even when a permission prompt
    // delays the command response.
    let now = Utc::now().timestamp_millis() - audio.active_elapsed_ms();
    let effective_interval = if state.brand.manifest().features.enable_periodic_screenshots
        && state.capture.is_supported()
    {
        meeting.screenshot_interval_sec
    } else {
        0
    };
    let scheduler = match CaptureScheduler::start(
        &state.capture_lease,
        &meeting.id,
        effective_interval,
        now,
    ) {
        Ok(scheduler) => scheduler,
        Err(error) => {
            drop(audio);
            tracing::warn!(meeting_id = %meeting.id, error = %error, "capture scheduler startup failed");
            cleanup_failed_start(&state, &meeting.id, &media_dir).await;
            return Err(error);
        }
    };

    // Persist audio paths immediately at recording start so an unexpected quit
    // or crash never leaves the SQLite row pointing at NULL.
    let audio_path_str = audio_path.to_string_lossy().into_owned();
    let system_path_str = system_started
        .then_some(system_path.as_ref())
        .flatten()
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    state
        .db
        .set_audio_file_paths(
            &meeting.id,
            Some(&audio_path_str),
            system_path_str.as_deref(),
            0,
        )
        .await?;
    state
        .db
        .set_meeting_status(&meeting.id, "recording")
        .await?;
    let meeting = state.db.get_meeting(&meeting.id).await?;

    let scheduler = Arc::new(Mutex::new(scheduler));
    let (cancel, cancel_rx) = tokio::sync::watch::channel(false);
    let (interval_tx, mut interval_rx) = tokio::sync::watch::channel(effective_interval);
    *active = Some(RecordingRuntime {
        meeting_id: meeting.id.clone(),
        started_at_ms: now,
        interval_sec: effective_interval,
        cancel,
        interval_tx,
        scheduler: Arc::clone(&scheduler),
        audio: Some(audio),
    });
    drop(active);

    #[cfg(desktop)]
    crate::tray::update_tray_recording_state(&app, Some(&meeting.title));

    let level_app = app.clone();
    let level_meeting = meeting.id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(sample) = level_rx.recv().await {
            let payload = AudioLevelsPayload {
                meeting_id: level_meeting.clone(),
                channel: sample.channel.as_str().into(),
                rms_dbfs: sample.rms_dbfs,
                peak_dbfs: sample.peak_dbfs,
                at_ms: sample.at_ms,
                echo_bleed: sample.echo_bleed,
                device_error: sample.device_error,
            };
            let _ = level_app.emit(crate::events::AUDIO_LEVELS, payload);
        }
    });

    {
        let app_handle = app.clone();
        let started_at = now;
        let mut screenshot_cancel_rx = cancel_rx.clone();
        let task_scheduler = Arc::clone(&scheduler);
        tauri::async_runtime::spawn(async move {
            let mut current_interval = *interval_rx.borrow();
            let mut ticker =
                tokio::time::interval(Duration::from_secs(current_interval.max(1) as u64));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = ticker.tick(), if current_interval > 0 => {
                        let now = Utc::now().timestamp_millis();
                        let state = app_handle.state::<AppState>();
                        let is_paused = state
                            .recording
                            .lock()
                            .await
                            .as_ref()
                            .and_then(|rt| rt.audio.as_ref())
                            .is_some_and(AudioCaptureSession::is_paused);
                        if is_paused {
                            continue;
                        }
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
                                tracing::warn!(error = %error, "automatic screenshot tick failed");
                            }
                        }
                    }
                    changed_interval = interval_rx.changed() => {
                        if changed_interval.is_err() {
                            break;
                        }
                        current_interval = *interval_rx.borrow();
                        if current_interval > 0 {
                            ticker = tokio::time::interval(Duration::from_secs(current_interval as u64));
                            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                        }
                    }
                    changed = screenshot_cancel_rx.changed() => {
                        if changed.is_err() || *screenshot_cancel_rx.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }

    state.is_recording.store(true, Ordering::SeqCst);

    // Warm synthesis model in background during recording so summary is fast at meeting end
    {
        let synthesis = state.synthesis.read().await.clone();
        tauri::async_runtime::spawn(async move {
            let _ = synthesis.warm().await;
        });
    }

    // Stream rolling live captions from the active microphone archive when
    // hardware tier allows keeping ASR warm and an ASR model is installed.
    crate::asr::spawn_live_caption_worker(
        app.clone(),
        meeting.id.clone(),
        audio_path,
        meeting.asr_model_id.clone(),
        cancel_rx,
    );

    tracing::info!(
        meeting_id = %meeting.id,
        system_audio_requested = want_system,
        system_audio_started = system_started,
        system_audio_warning = ?system_audio_warning,
        screenshot_interval_sec = effective_interval,
        "started recording session"
    );

    app.emit(
        crate::events::MEETING_CHANGED,
        crate::events::MeetingChangedPayload {
            meeting: meeting.clone(),
        },
    )
    .map_err(|error| AppError::Invalid(format!("cannot emit meeting change: {error}")))?;
    Ok(StartRecordingOutcome {
        meeting,
        system_audio_warning,
    })
}

async fn cleanup_failed_start(state: &AppState, meeting_id: &str, media_dir: &std::path::Path) {
    if let Err(error) = state.db.delete_meeting(meeting_id).await {
        tracing::warn!(meeting_id, error = %error, "could not remove failed recording row");
    }
    if let Err(error) = std::fs::remove_dir_all(media_dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(meeting_id, error = %error, "could not remove failed recording media");
        }
    }
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
    let mut outcome: Option<AudioCaptureTake> = None;
    let mut failure: Option<String> = None;

    if let Some(mut runtime) = runtime {
        let _ = runtime.cancel.send(true);
        if let Some(audio) = runtime.audio.take() {
            match tokio::task::spawn_blocking(move || audio.stop()).await {
                Ok(Ok(finished)) => outcome = Some(finished),
                Ok(Err(error)) => failure = Some(error.to_string()),
                Err(error) => failure = Some(format!("audio finalize task failed: {error}")),
            }
        }
    }

    if let Some(finished) = outcome.as_ref() {
        let microphone = finished
            .microphone
            .as_ref()
            .map(|microphone| microphone.path_string());
        let system = finished.system.as_ref();
        if let Err(error) = state
            .db
            .set_audio_file_paths(
                &meeting_id,
                microphone.as_deref(),
                system.map(AudioCaptureOutcome::path_string).as_deref(),
                system.map(|system| system.started_at_ms).unwrap_or(0),
            )
            .await
        {
            failure.get_or_insert_with(|| error.to_string());
        }
        if let Some(error) = finished
            .microphone
            .as_ref()
            .and_then(|microphone| microphone.error.clone())
        {
            failure.get_or_insert_with(|| format!("microphone: {error}"));
        }
    }

    let existing_duration = state.db.get_meeting(&meeting_id).await?.duration_ms;
    let duration = outcome
        .as_ref()
        .map(AudioCaptureTake::duration_ms)
        .filter(|duration| *duration > 0)
        .or_else(|| (wall_clock_ms > 0).then_some(wall_clock_ms))
        .unwrap_or(existing_duration);
    let meeting = state.db.finish_meeting(&meeting_id, duration).await?;

    let microphone = outcome.as_ref().and_then(|take| take.microphone.as_ref());
    let system = outcome.as_ref().and_then(|take| take.system.as_ref());
    let stopped = RecordingStoppedPayload {
        meeting_id: meeting_id.clone(),
        duration_ms: meeting.duration_ms,
        path: microphone.map(|finished| finished.path_string()),
        silent: microphone.is_some_and(|finished| finished.silent),
        dropped_blocks: microphone
            .map(|finished| finished.dropped_blocks)
            .unwrap_or(0),
        peak_dbfs: microphone
            .map(|finished| finished.peak_dbfs)
            .unwrap_or(-120.0),
        system: system.map(|finished| SystemAudioFacts {
            path: finished.path_string(),
            started_at_ms: finished.started_at_ms,
            duration_ms: finished.duration_ms,
            silent: finished.silent,
            dropped_blocks: finished.dropped_blocks,
            peak_dbfs: finished.peak_dbfs,
            error: finished.error.clone(),
        }),
        system_error: outcome.as_ref().and_then(|take| take.system_error.clone()),
        error: failure.clone(),
    };
    let _ = crate::events::emit(&app, crate::events::RECORDING_STOPPED, stopped);
    state.is_recording.store(false, Ordering::SeqCst);
    if let Some(cached) = state.asr.lock().await.as_mut() {
        cached.last_used = std::time::Instant::now();
    }
    #[cfg(desktop)]
    crate::tray::update_tray_recording_state(&app, None);

    tracing::info!(
        meeting_id = %meeting.id,
        duration_ms = meeting.duration_ms,
        failure = ?failure,
        "stopped recording session"
    );

    app.emit(
        crate::events::MEETING_CHANGED,
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

#[tauri::command]
pub async fn pause_recording(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<RecordingSnapshot> {
    let active = state.recording.lock().await;
    let runtime = active
        .as_ref()
        .filter(|rt| rt.meeting_id == meeting_id)
        .ok_or_else(|| {
            AppError::Capture(format!("meeting {meeting_id} is not actively recording"))
        })?;
    if let Some(audio) = runtime.audio.as_ref() {
        audio.pause();
    }
    Ok(runtime.snapshot())
}

#[tauri::command]
pub async fn resume_recording(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<RecordingSnapshot> {
    let active = state.recording.lock().await;
    let runtime = active
        .as_ref()
        .filter(|rt| rt.meeting_id == meeting_id)
        .ok_or_else(|| {
            AppError::Capture(format!("meeting {meeting_id} is not actively recording"))
        })?;
    if let Some(audio) = runtime.audio.as_ref() {
        audio.resume();
    }
    Ok(runtime.snapshot())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCapabilities {
    pub microphone: bool,
    pub system_audio: bool,
    pub system_backend: Option<String>,
    pub system_audio_permission_required: bool,
    pub system_audio_permission_granted: bool,
    pub screenshot_capture: bool,
    pub diarization: bool,
    pub echo_cancellation: bool,
    pub archive_sample_rate: u32,
    pub note: Option<String>,
}

#[tauri::command]
pub fn audio_capabilities(state: State<'_, AppState>) -> AudioCapabilities {
    audio_capabilities_for(&state)
}

pub fn audio_capabilities_for(state: &AppState) -> AudioCapabilities {
    let supported = system_audio_supported();
    AudioCapabilities {
        microphone: true,
        system_audio: supported,
        system_backend: system_audio_backend().map(str::to_string),
        system_audio_permission_required: cfg!(target_os = "macos") && supported,
        system_audio_permission_granted: system_audio_permission_granted(),
        screenshot_capture: state.capture.is_supported(),
        diarization: true,
        echo_cancellation: false,
        archive_sample_rate: ARCHIVE_SAMPLE_RATE,
        note: supported.then(|| {
            "System audio records what this machine plays. Speaker labels come from on-device \
             acoustic clustering; echo cancellation is not applied, so wear headphones."
                .into()
        }),
    }
}

#[tauri::command]
pub fn request_system_audio_access() -> bool {
    request_system_audio_permission()
}
