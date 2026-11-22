//! Screenshot hashing, WebP encoding, path planning, and capture policy.
//!
//! Capture itself is delegated to a platform backend; this module owns the
//! deterministic parts that can be unit-tested: perceptual deduplication,
//! file naming, interval policy, the single-session lease, and the scheduler.

pub mod capture;
pub mod dhash;
pub mod encode;
pub mod ocr;
pub mod paths;
pub mod policy;

pub use capture::{
    default_backend, CaptureTarget, CapturedFrame, ScreenCapture, SyntheticScreenCapture,
    SystemScreenCapture, VisualCaptureTarget, MAX_SCREENSHOT_WIDTH,
};
pub use dhash::{
    dhash_file, dhash_rgba, hamming_distance, hash_to_hex, is_near_duplicate, parse_hash,
};
pub use encode::{encode_webp, webp_dimensions};
pub use ocr::{default_ocr_engine, OcrEngine, SyntheticOcr, UnavailableOcr};
pub use paths::{relative_link, sanitize_filename, ScreenshotPathPlanner};
pub use policy::{
    CaptureDecision, CaptureLease, CaptureLeaseGuard, CaptureScheduler, CaptureSession,
    ScreenshotPolicy, DEFAULT_DEDUP_THRESHOLD, DEFAULT_INTERVAL_SEC, MAX_INTERVAL_SEC,
    MIN_INTERVAL_SEC,
};
