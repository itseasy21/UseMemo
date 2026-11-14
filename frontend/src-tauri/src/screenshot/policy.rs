//! Capture interval policy, single-session lease, and scheduler.
//!
//! Periodic capture is intentionally conservative: a screenshot is only taken
//! when the interval elapsed *and* the frame differs from the last accepted
//! frame. Unchanged frames extend the previous screenshot instead of filling
//! the vault with duplicates.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::screenshot::dhash::is_near_duplicate;

pub const MIN_INTERVAL_SEC: i64 = 5;
pub const MAX_INTERVAL_SEC: i64 = 3_600;
pub const DEFAULT_INTERVAL_SEC: i64 = 10;
pub const DEFAULT_DEDUP_THRESHOLD: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureDecision {
    Capture,
    SkipNotDue,
    SkipDuplicate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotPolicy {
    interval_sec: i64,
    dedup_threshold: u32,
}

impl ScreenshotPolicy {
    pub fn new(interval_sec: i64) -> AppResult<Self> {
        Self::with_threshold(interval_sec, DEFAULT_DEDUP_THRESHOLD)
    }

    pub fn with_threshold(interval_sec: i64, dedup_threshold: u32) -> AppResult<Self> {
        if interval_sec != 0 && !(MIN_INTERVAL_SEC..=MAX_INTERVAL_SEC).contains(&interval_sec) {
            return Err(AppError::Invalid(format!(
                "screenshot interval must be 0 (manual) or between {MIN_INTERVAL_SEC} and {MAX_INTERVAL_SEC} seconds"
            )));
        }
        if dedup_threshold > 64 {
            return Err(AppError::Invalid(
                "dedup threshold must be between 0 and 64 bits".into(),
            ));
        }
        Ok(Self {
            interval_sec,
            dedup_threshold,
        })
    }

    pub fn interval_sec(&self) -> i64 {
        self.interval_sec
    }

    pub fn is_manual(&self) -> bool {
        self.interval_sec == 0
    }

    pub fn interval_ms(&self) -> i64 {
        self.interval_sec * 1_000
    }

    pub fn dedup_threshold(&self) -> u32 {
        self.dedup_threshold
    }

    pub fn evaluate(
        &self,
        elapsed_since_last_ms: i64,
        last_hash: Option<u64>,
        current_hash: Option<u64>,
    ) -> CaptureDecision {
        if self.is_manual() || elapsed_since_last_ms < self.interval_ms() {
            return CaptureDecision::SkipNotDue;
        }
        if let (Some(previous), Some(current)) = (last_hash, current_hash) {
            if is_near_duplicate(previous, current, self.dedup_threshold) {
                return CaptureDecision::SkipDuplicate;
            }
        }
        CaptureDecision::Capture
    }

    pub fn evaluate_manual(
        &self,
        last_hash: Option<u64>,
        current_hash: Option<u64>,
    ) -> CaptureDecision {
        if let (Some(previous), Some(current)) = (last_hash, current_hash) {
            if is_near_duplicate(previous, current, self.dedup_threshold) {
                return CaptureDecision::SkipDuplicate;
            }
        }
        CaptureDecision::Capture
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSession {
    pub meeting_id: String,
    pub started_at_ms: i64,
    pub policy: ScreenshotPolicy,
    pub last_capture_at_ms: Option<i64>,
    pub last_hash: Option<u64>,
    pub captured_count: u64,
    pub duplicate_count: u64,
}

impl CaptureSession {
    pub fn new(
        meeting_id: impl Into<String>,
        interval_sec: i64,
        started_at_ms: i64,
    ) -> AppResult<Self> {
        Ok(Self {
            meeting_id: meeting_id.into(),
            started_at_ms: started_at_ms.max(0),
            policy: ScreenshotPolicy::new(interval_sec)?,
            last_capture_at_ms: None,
            last_hash: None,
            captured_count: 0,
            duplicate_count: 0,
        })
    }

    /// The first frame is due immediately: the reference point is one interval
    /// before the session started.
    pub fn elapsed_since_last(&self, now_ms: i64) -> i64 {
        match self.last_capture_at_ms {
            Some(last) => now_ms.saturating_sub(last),
            None => now_ms
                .saturating_sub(self.started_at_ms)
                .saturating_add(self.policy.interval_ms()),
        }
    }

    pub fn evaluate(&self, now_ms: i64, current_hash: Option<u64>) -> CaptureDecision {
        self.policy.evaluate(
            self.elapsed_since_last(now_ms),
            self.last_hash,
            current_hash,
        )
    }

    pub fn evaluate_manual(&self, current_hash: Option<u64>) -> CaptureDecision {
        self.policy.evaluate_manual(self.last_hash, current_hash)
    }

    pub fn record(&mut self, now_ms: i64, hash: Option<u64>, decision: CaptureDecision) {
        match decision {
            CaptureDecision::Capture => {
                self.last_capture_at_ms = Some(now_ms);
                if hash.is_some() {
                    self.last_hash = hash;
                }
                self.captured_count += 1;
            }
            CaptureDecision::SkipDuplicate => {
                // Wait another full interval before probing again.
                self.last_capture_at_ms = Some(now_ms);
                self.duplicate_count += 1;
            }
            CaptureDecision::SkipNotDue => {}
        }
    }
}

/// Process-wide single-recording lease. Creating a second capture session while
/// one is active fails closed, which prevents two schedulers writing into the
/// same meeting (or two meetings stealing the screen recorder).
#[derive(Debug, Clone, Default)]
pub struct CaptureLease {
    owner: Arc<Mutex<Option<String>>>,
}

#[derive(Debug)]
pub struct CaptureLeaseGuard {
    owner: Arc<Mutex<Option<String>>>,
    meeting_id: String,
}

impl CaptureLease {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn try_acquire(&self, meeting_id: &str) -> AppResult<CaptureLeaseGuard> {
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| AppError::Capture("capture lease is poisoned".into()))?;
        if let Some(existing) = owner.as_deref() {
            return Err(AppError::Capture(format!(
                "screenshot capture already active for meeting {existing}"
            )));
        }
        *owner = Some(meeting_id.to_string());
        Ok(CaptureLeaseGuard {
            owner: Arc::clone(&self.owner),
            meeting_id: meeting_id.to_string(),
        })
    }

    pub fn owner(&self) -> Option<String> {
        self.owner.lock().ok().and_then(|owner| owner.clone())
    }

    pub fn is_active(&self) -> bool {
        self.owner().is_some()
    }
}

impl Drop for CaptureLeaseGuard {
    fn drop(&mut self) {
        if let Ok(mut owner) = self.owner.lock() {
            if owner.as_deref() == Some(self.meeting_id.as_str()) {
                *owner = None;
            }
        }
    }
}

/// Scheduler state. The platform backend calls `evaluate` when a frame is ready;
/// it owns the lease for the lifetime of the recording.
#[derive(Debug)]
pub struct CaptureScheduler {
    session: CaptureSession,
    lease: CaptureLeaseGuard,
}

impl CaptureScheduler {
    pub fn start(
        lease: &CaptureLease,
        meeting_id: &str,
        interval_sec: i64,
        started_at_ms: i64,
    ) -> AppResult<Self> {
        let session = CaptureSession::new(meeting_id, interval_sec, started_at_ms)?;
        let lease = lease.try_acquire(meeting_id)?;
        Ok(Self { session, lease })
    }

    pub fn session(&self) -> &CaptureSession {
        &self.session
    }

    pub fn session_mut(&mut self) -> &mut CaptureSession {
        &mut self.session
    }

    pub fn meeting_id(&self) -> &str {
        &self.session.meeting_id
    }

    pub fn evaluate(&self, now_ms: i64, current_hash: Option<u64>) -> CaptureDecision {
        self.session.evaluate(now_ms, current_hash)
    }

    pub fn evaluate_manual(&self, current_hash: Option<u64>) -> CaptureDecision {
        self.session.evaluate_manual(current_hash)
    }

    pub fn record(&mut self, now_ms: i64, hash: Option<u64>, decision: CaptureDecision) {
        self.session.record(now_ms, hash, decision);
    }

    pub fn stop(self) {
        drop(self.lease);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_policy_requires_due_and_distinct_frames() {
        let policy = ScreenshotPolicy::new(10).unwrap();
        assert_eq!(
            policy.evaluate(9_999, None, Some(1)),
            CaptureDecision::SkipNotDue
        );
        assert_eq!(
            policy.evaluate(10_000, None, Some(1)),
            CaptureDecision::Capture
        );
        assert_eq!(
            policy.evaluate(10_000, Some(1), Some(2)),
            CaptureDecision::SkipDuplicate
        );
        assert_eq!(
            policy.evaluate(10_000, Some(0), Some(u64::MAX)),
            CaptureDecision::Capture
        );
    }

    #[test]
    fn manual_mode_never_fires_automatically_but_supports_snap() {
        let policy = ScreenshotPolicy::new(0).unwrap();
        assert!(policy.is_manual());
        assert_eq!(
            policy.evaluate(999_999, None, Some(1)),
            CaptureDecision::SkipNotDue
        );
        assert_eq!(
            policy.evaluate_manual(None, Some(1)),
            CaptureDecision::Capture
        );
    }

    #[test]
    fn scheduler_produces_four_frames_in_a_35_second_session() {
        let lease = CaptureLease::new();
        let mut scheduler = CaptureScheduler::start(&lease, "meeting-1", 10, 0).unwrap();
        let mut captures = Vec::new();
        for second in 0..=35 {
            let now = second * 1_000;
            let bucket = second as u64 / 10;
            let hash = Some(0xDEAD_BEEF_0000_0000 ^ bucket.wrapping_mul(0x1111_1111_1111_1111));
            let decision = scheduler.evaluate(now, hash);
            if decision == CaptureDecision::Capture {
                captures.push(second);
            }
            scheduler.record(now, hash, decision);
        }
        assert_eq!(captures, vec![0, 10, 20, 30]);
        assert_eq!(scheduler.session().captured_count, 4);
    }

    #[test]
    fn duplicate_frames_are_skipped_and_counted() {
        let mut session = CaptureSession::new("m", 10, 0).unwrap();
        session.record(0, Some(7), CaptureDecision::Capture);
        let decision = session.evaluate(10_000, Some(7));
        assert_eq!(decision, CaptureDecision::SkipDuplicate);
        session.record(10_000, Some(7), decision);
        assert_eq!(session.captured_count, 1);
        assert_eq!(session.duplicate_count, 1);
        // The duplicate did not replace the accepted hash.
        assert_eq!(session.last_hash, Some(7));
    }

    #[test]
    fn lease_allows_only_one_session_and_releases_on_drop() {
        let lease = CaptureLease::new();
        let guard = lease.try_acquire("m1").unwrap();
        assert!(lease.try_acquire("m2").is_err());
        assert_eq!(lease.owner().as_deref(), Some("m1"));
        drop(guard);
        assert!(!lease.is_active());
        let _guard = lease.try_acquire("m2").unwrap();
        assert_eq!(lease.owner().as_deref(), Some("m2"));
    }

    #[test]
    fn invalid_intervals_are_rejected() {
        assert!(ScreenshotPolicy::new(4).is_err());
        assert!(ScreenshotPolicy::new(3_601).is_err());
        assert!(ScreenshotPolicy::new(-1).is_err());
        assert!(ScreenshotPolicy::with_threshold(10, 65).is_err());
    }
}
