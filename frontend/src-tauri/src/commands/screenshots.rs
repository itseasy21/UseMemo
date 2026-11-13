use chrono::Utc;
use tauri::{AppHandle, State};

use crate::error::AppResult;
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
    let existing = state.db.list_screenshots(&meeting.id).await?;
    if let Some(last) = existing.last() {
        scheduler.session_mut().last_hash = parse_hash(&last.dhash).ok();
        scheduler.session_mut().last_capture_at_ms = Some(last.start_ms);
    }
    let now = Utc::now().timestamp_millis();
    let started_at = now.saturating_sub(meeting.duration_ms.max(0));
    capture_once(state, &mut scheduler, MANUAL_TRIGGER, now, started_at).await
}

/// Capture, deduplicate, encode, persist, and describe one frame. The caller
/// owns the event emission so both the periodic task and manual command use the
/// same path.
pub async fn capture_once(
    state: &AppState,
    scheduler: &mut CaptureScheduler,
    trigger: &str,
    now_ms: i64,
    started_at_ms: i64,
) -> AppResult<ScreenshotCapturedPayload> {
    let frame = state.capture.capture()?;
    let hash = frame.dhash()?;
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
                &frame,
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
            let last = state
                .db
                .list_screenshots(&meeting_id)
                .await?
                .into_iter()
                .next_back();
            if let Some(last) = last {
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
    frame: &CapturedFrame,
    hash: u64,
    offset_ms: i64,
    interval_ms: i64,
    trigger: &str,
) -> AppResult<Screenshot> {
    let shots_dir = state.paths.meeting_shots_dir(meeting_id);
    std::fs::create_dir_all(&shots_dir)?;
    let planner = ScreenshotPathPlanner::new(&shots_dir);
    let path = planner.plan(offset_ms, hash);
    let bytes = encode_webp(&frame.rgba, frame.width, frame.height, 82.0)?;
    std::fs::write(&path, bytes)?;
    state
        .db
        .insert_screenshot(
            meeting_id,
            NewScreenshot {
                start_ms: offset_ms,
                end_ms: offset_ms.saturating_add(interval_ms),
                file_path: path.to_string_lossy().into_owned(),
                width: frame.width as i64,
                height: frame.height as i64,
                dhash: hash_to_hex(hash),
                capture_trigger: if trigger == MANUAL_TRIGGER {
                    MANUAL_TRIGGER.into()
                } else {
                    INTERVAL_TRIGGER.into()
                },
                ocr_extracted_text: None,
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
    state.db.get_screenshot(&screenshot_id).await?;
    state.db.update_screenshot_ocr(&screenshot_id, &text).await
}
