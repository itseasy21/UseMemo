use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::events::ScreenshotCapturedPayload;
use crate::screenshot::dhash::{hash_to_hex, parse_hash};
use crate::screenshot::encode::encode_webp;
use crate::screenshot::paths::ScreenshotPathPlanner;
use crate::screenshot::policy::{CaptureDecision, CaptureScheduler};
use crate::screenshot::CapturedFrame;
use crate::state::AppState;
use crate::storage::{NewScreenshot, Screenshot};

const INTERVAL_TRIGGER: &str = "interval";
const MANUAL_TRIGGER: &str = "manual";

#[tauri::command]
pub async fn list_screenshots(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<Vec<Screenshot>> {
    state.db.list_screenshots(&meeting_id).await
}

#[tauri::command]
pub async fn delete_screenshot(state: State<'_, AppState>, screenshot_id: String) -> AppResult<()> {
    let deleted = state.db.delete_screenshot(&screenshot_id).await?;
    let path = PathBuf::from(&deleted.file_path);
    let _ = tokio::task::spawn_blocking(move || {
        if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
    })
    .await;
    Ok(())
}

#[tauri::command]
pub async fn capture_screenshot(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<ScreenshotCapturedPayload> {
    let meeting = state.db.get_meeting(&meeting_id).await?;
    let active_scheduler = {
        let active = state.recording.lock().await;
        active
            .as_ref()
            .filter(|runtime| runtime.meeting_id == meeting_id)
            .map(|runtime| (runtime.scheduler.clone(), runtime.started_at_ms))
    };

    let payload = if let Some((scheduler, started_at)) = active_scheduler {
        let mut scheduler = scheduler.lock().await;
        let now = Utc::now().timestamp_millis();
        capture_once(&state, &mut scheduler, MANUAL_TRIGGER, now, started_at).await?
    } else {
        capture_manual_offline(&state, &meeting).await?
    };
    crate::events::screenshot_event(&app, payload.clone())?;
    Ok(payload)
}

async fn capture_manual_offline(
    state: &AppState,
    meeting: &crate::storage::Meeting,
) -> AppResult<ScreenshotCapturedPayload> {
    let mut scheduler =
        CaptureScheduler::start(&state.capture_lease, &meeting.id, 0, meeting.created_at)?;
    if let Some(last) = state.db.latest_screenshot(&meeting.id).await? {
        scheduler.session_mut().last_hash = parse_hash(&last.dhash).ok();
        scheduler.session_mut().last_capture_at_ms = Some(last.start_ms);
    }
    let now = Utc::now().timestamp_millis();
    let started_at = now.saturating_sub(meeting.duration_ms.max(0));
    capture_once(state, &mut scheduler, MANUAL_TRIGGER, now, started_at).await
}

/// Capture, deduplicate, encode, persist, and describe one frame off the Tokio
/// async worker pool so 5K image decoding/WebP encoding never stalls IPC.
pub async fn capture_once(
    state: &AppState,
    scheduler: &mut CaptureScheduler,
    trigger: &str,
    now_ms: i64,
    started_at_ms: i64,
) -> AppResult<ScreenshotCapturedPayload> {
    let capture_backend = Arc::clone(&state.capture);
    let (frame, hash) = tokio::task::spawn_blocking(move || -> AppResult<(CapturedFrame, u64)> {
        let frame = capture_backend.capture()?;
        let hash = frame.dhash()?;
        Ok((frame, hash))
    })
    .await
    .map_err(|error| AppError::Capture(format!("screenshot capture task panicked: {error}")))??;

    let decision = if trigger == MANUAL_TRIGGER {
        scheduler.evaluate_manual(Some(hash))
    } else {
        scheduler.evaluate(now_ms, Some(hash))
    };
    scheduler.record(now_ms, Some(hash), decision);

    let meeting_id = scheduler.session().meeting_id.clone();
    let interval_ms = scheduler.session().policy.interval_ms().max(1_000);
    let offset_ms = (now_ms - started_at_ms).max(0);
    match decision {
        CaptureDecision::Capture => {
            let shot = persist_frame(
                state,
                &meeting_id,
                frame,
                hash,
                offset_ms,
                interval_ms,
                trigger,
            )
            .await?;
            Ok(ScreenshotCapturedPayload::captured(meeting_id, shot))
        }
        CaptureDecision::SkipDuplicate => {
            let end_ms = offset_ms.saturating_add(interval_ms);
            if let Some(last) = state.db.latest_screenshot(&meeting_id).await? {
                state.db.extend_screenshot(&last.id, end_ms).await?;
            }
            Ok(ScreenshotCapturedPayload::duplicate(
                meeting_id,
                "frame is perceptually identical to the previous screenshot",
            ))
        }
        CaptureDecision::SkipNotDue => Ok(ScreenshotCapturedPayload::skipped(
            meeting_id,
            "screenshot interval has not elapsed",
        )),
    }
}

async fn persist_frame(
    state: &AppState,
    meeting_id: &str,
    frame: CapturedFrame,
    hash: u64,
    offset_ms: i64,
    interval_ms: i64,
    trigger: &str,
) -> AppResult<Screenshot> {
    let shots_dir = state.paths.meeting_shots_dir(meeting_id);
    let width = frame.width;
    let height = frame.height;
    let ocr_enabled = state.brand.manifest().features.enable_slide_vision_ocr;
    let ocr_engine = if ocr_enabled {
        Some(state.ocr.read().await.clone())
    } else {
        None
    };

    let (path, ocr_extracted_text) =
        tokio::task::spawn_blocking(move || -> AppResult<(PathBuf, Option<String>)> {
            std::fs::create_dir_all(&shots_dir)?;
            let planner = ScreenshotPathPlanner::new(&shots_dir);
            let path = planner.plan(offset_ms, hash);
            let bytes = encode_webp(&frame.rgba, frame.width, frame.height, 82.0)?;
            std::fs::write(&path, bytes)?;

            let ocr_text = match ocr_engine {
                Some(engine) if engine.engine_id() != "unavailable" => {
                    match engine.recognize_rgba(frame.width, frame.height, &frame.rgba) {
                        Ok(text) => {
                            let trimmed = text.trim();
                            (!trimmed.is_empty()).then(|| trimmed.to_string())
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "slide OCR failed during frame capture");
                            None
                        }
                    }
                }
                _ => None,
            };

            Ok((path, ocr_text))
        })
        .await
        .map_err(|error| {
            AppError::Capture(format!("screenshot encode task panicked: {error}"))
        })??;

    state
        .db
        .insert_screenshot(
            meeting_id,
            NewScreenshot {
                start_ms: offset_ms,
                end_ms: offset_ms.saturating_add(interval_ms),
                file_path: path.to_string_lossy().into_owned(),
                width: width as i64,
                height: height as i64,
                dhash: hash_to_hex(hash),
                capture_trigger: if trigger == MANUAL_TRIGGER {
                    MANUAL_TRIGGER.into()
                } else {
                    INTERVAL_TRIGGER.into()
                },
                ocr_extracted_text,
            },
        )
        .await
}

#[tauri::command]
pub async fn update_screenshot_ocr(
    state: State<'_, AppState>,
    screenshot_id: String,
    text: String,
) -> AppResult<()> {
    state.db.update_screenshot_ocr(&screenshot_id, &text).await
}

#[tauri::command]
pub async fn analyze_screenshot_ocr(
    state: State<'_, AppState>,
    screenshot_id: String,
) -> AppResult<Screenshot> {
    if !state.brand.manifest().features.enable_slide_vision_ocr {
        return Err(AppError::Invalid(
            "slide vision OCR is disabled by brand configuration".into(),
        ));
    }
    let shot = state.db.get_screenshot(&screenshot_id).await?;
    let engine = state.ocr.read().await.clone();
    if engine.engine_id() == "unavailable" {
        return Err(AppError::Capture(
            "native on-device slide OCR is not available on this operating system".into(),
        ));
    }

    let path = PathBuf::from(&shot.file_path);
    let extracted = tokio::task::spawn_blocking(move || engine.recognize_file(&path))
        .await
        .map_err(|error| AppError::Capture(format!("OCR task panicked: {error}")))??;

    state
        .db
        .update_screenshot_ocr(&screenshot_id, &extracted)
        .await?;
    state.db.get_screenshot(&screenshot_id).await
}
