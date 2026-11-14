//! Shared Tauri application state.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::{watch, Mutex};

use crate::brand::{Brand, BrandPaths};
use crate::error::{AppError, AppResult};
use crate::model_registry::HardwareProfile;
use crate::models::ModelDownloader;
use crate::screenshot::capture::{default_backend, ScreenCapture};
use crate::screenshot::policy::{CaptureLease, CaptureScheduler};
use crate::storage::Database;
use crate::synthesis::orchestrator::SynthesisEngine;
use crate::synthesis::types::SynthesisRequest;

/// Engine placeholder until the bundled LiteRT-LM sidecar is running. Commands
/// fail closed instead of silently falling back to a non-existent cloud call.
pub struct UnavailableEngine;

#[async_trait]
impl SynthesisEngine for UnavailableEngine {
    fn engine_id(&self) -> &str {
        "litert-lm-sidecar"
    }

    async fn generate(&self, _request: SynthesisRequest) -> AppResult<String> {
        Err(AppError::Synthesis(
            "the on-device LiteRT-LM worker is not running; install a model in the Model Studio first"
                .into(),
        ))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSnapshot {
    pub meeting_id: String,
    pub started_at_ms: i64,
    pub interval_sec: i64,
}

pub struct RecordingRuntime {
    pub meeting_id: String,
    pub started_at_ms: i64,
    pub interval_sec: i64,
    pub cancel: watch::Sender<bool>,
    pub scheduler: Arc<Mutex<CaptureScheduler>>,
}

impl RecordingRuntime {
    pub fn snapshot(&self) -> RecordingSnapshot {
        RecordingSnapshot {
            meeting_id: self.meeting_id.clone(),
            started_at_ms: self.started_at_ms,
            interval_sec: self.interval_sec,
        }
    }
}

pub struct AppState {
    pub brand: Brand,
    pub paths: BrandPaths,
    pub db: Database,
    pub models: ModelDownloader,
    pub hardware: HardwareProfile,
    pub capture: Box<dyn ScreenCapture>,
    pub synthesis: Arc<dyn SynthesisEngine>,
    pub capture_lease: CaptureLease,
    pub recording: Mutex<Option<RecordingRuntime>>,
}

impl AppState {
    pub async fn initialize(
        brand: Brand,
        capture: Box<dyn ScreenCapture>,
        synthesis: Arc<dyn SynthesisEngine>,
    ) -> AppResult<Self> {
        let paths = brand.paths()?;
        paths.ensure()?;
        let db = Database::connect(&paths.db_path).await?;
        let models = ModelDownloader::new(
            brand.manifest().model_registry.hf_base_url.clone(),
            &paths.models_dir,
        )?;
        let hardware = HardwareProfile::detect();
        Ok(Self {
            brand,
            paths,
            db,
            models,
            hardware,
            capture,
            synthesis,
            capture_lease: CaptureLease::new(),
            recording: Mutex::new(None),
        })
    }

    pub async fn recording_snapshot(&self) -> Option<RecordingSnapshot> {
        self.recording
            .lock()
            .await
            .as_ref()
            .map(RecordingRuntime::snapshot)
    }
}

pub type StateParts = (Brand, Box<dyn ScreenCapture>, Arc<dyn SynthesisEngine>);

pub fn production_state_parts() -> AppResult<StateParts> {
    let brand = Brand::load(None)?;
    let paths = brand.paths()?;
    let hardware = HardwareProfile::detect();
    let synthesis =
        crate::synthesis::sidecar::sidecar_from_brand(&brand, &paths.models_dir, &hardware)
            .unwrap_or_else(|| Arc::new(UnavailableEngine) as Arc<dyn SynthesisEngine>);
    Ok((brand, default_backend(), synthesis))
}
