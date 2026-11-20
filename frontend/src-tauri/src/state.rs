//! Shared Tauri application state.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::{watch, Mutex, RwLock};

use crate::brand::{Brand, BrandPaths};
use crate::error::{AppError, AppResult};
use crate::logging::init_logging;
use crate::model_registry::HardwareProfile;
use crate::models::ModelDownloader;
use crate::screenshot::capture::{default_backend, ScreenCapture};
use crate::screenshot::ocr::{default_ocr_engine, OcrEngine};
use crate::screenshot::policy::{CaptureLease, CaptureScheduler};
use crate::storage::Database;
use crate::synthesis::orchestrator::SynthesisEngine;
use crate::synthesis::types::SynthesisRequest;

/// Engine placeholder when no local SLM runtime/weights are provisioned yet.
/// Commands fail closed instead of silently falling back to a cloud call.
pub struct UnavailableEngine;

#[async_trait]
impl SynthesisEngine for UnavailableEngine {
    fn engine_id(&self) -> &str {
        "unavailable"
    }

    async fn generate(&self, _request: SynthesisRequest) -> AppResult<String> {
        Err(AppError::Synthesis(
            "no on-device synthesis model is installed or active; download a synthesis model in Model Studio first"
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
    pub paused: bool,
    pub mic_device: Option<String>,
    pub mic_sample_rate: Option<u32>,
}

pub struct RecordingRuntime {
    pub meeting_id: String,
    pub started_at_ms: i64,
    pub interval_sec: i64,
    pub cancel: watch::Sender<bool>,
    pub interval_tx: watch::Sender<i64>,
    pub scheduler: Arc<Mutex<CaptureScheduler>>,
    pub audio: Option<crate::audio::AudioCaptureSession>,
}

impl RecordingRuntime {
    pub fn snapshot(&self) -> RecordingSnapshot {
        RecordingSnapshot {
            meeting_id: self.meeting_id.clone(),
            started_at_ms: self.started_at_ms,
            interval_sec: self.interval_sec,
            paused: self
                .audio
                .as_ref()
                .is_some_and(crate::audio::AudioCaptureSession::is_paused),
            mic_device: self
                .audio
                .as_ref()
                .map(|audio| audio.info().device_name.clone()),
            mic_sample_rate: self.audio.as_ref().map(|audio| audio.info().sample_rate),
        }
    }
}

pub struct CachedAsr {
    pub model_id: String,
    pub engine: Arc<dyn crate::asr::AsrEngine>,
    pub last_used: std::time::Instant,
}

pub struct AppState {
    pub brand: Brand,
    pub paths: BrandPaths,
    pub db: Database,
    pub models: ModelDownloader,
    pub hardware: HardwareProfile,
    pub capture: Arc<dyn ScreenCapture>,
    pub ocr: RwLock<Arc<dyn OcrEngine>>,
    /// Hot-swappable synthesis engine so installing or switching models in Model
    /// Studio activates immediately without restarting the application.
    pub synthesis: RwLock<Arc<dyn SynthesisEngine>>,
    pub capture_lease: CaptureLease,
    pub recording: Mutex<Option<RecordingRuntime>>,
    pub is_recording: Arc<AtomicBool>,
    /// Only one transcription runs at a time.
    pub transcribing: Mutex<()>,
    /// Cooperative cancellation flag for active batch transcription.
    pub asr_cancelled: Arc<AtomicBool>,
    /// Loaded ASR engine, keyed by its actual resolved model ID and touch timestamp.
    pub asr: Arc<Mutex<Option<CachedAsr>>>,
    pub asr_reaper_active: Arc<AtomicBool>,
    /// Number of interrupted sessions recovered during startup initialization.
    pub recovered_sessions: usize,
}

impl AppState {
    pub async fn initialize(
        brand: Brand,
        capture: Arc<dyn ScreenCapture>,
        synthesis: Arc<dyn SynthesisEngine>,
    ) -> AppResult<Self> {
        let paths = brand.paths()?;
        paths.ensure()?;
        init_logging(&paths.cache_dir);
        let db = Database::connect(&paths.db_path).await?;
        let recovered_sessions = match db.recover_interrupted_meetings(&paths).await {
            Ok(count) => {
                if count > 0 {
                    tracing::warn!(
                        recovered = count,
                        "recovered interrupted recording/processing sessions at startup"
                    );
                }
                count
            }
            Err(error) => {
                tracing::error!(error = %error, "startup session recovery encountered an error");
                0
            }
        };
        let models = ModelDownloader::new(
            brand.manifest().model_registry.hf_base_url.clone(),
            &paths.models_dir,
        )?;
        let hardware = HardwareProfile::detect();
        let ocr: Arc<dyn OcrEngine> = Arc::from(default_ocr_engine());
        tracing::info!(
            brand_id = %brand.manifest().brand_id,
            tier = %hardware.tier.as_str(),
            ram_gb = hardware.ram_gb,
            ocr_engine = %ocr.engine_id(),
            recovered_sessions,
            "initialized AppState"
        );
        Ok(Self {
            brand,
            paths,
            db,
            models,
            hardware,
            capture,
            ocr: RwLock::new(ocr),
            synthesis: RwLock::new(synthesis),
            capture_lease: CaptureLease::new(),
            recording: Mutex::new(None),
            is_recording: Arc::new(AtomicBool::new(false)),
            transcribing: Mutex::new(()),
            asr_cancelled: Arc::new(AtomicBool::new(false)),
            asr: Arc::new(Mutex::new(None)),
            asr_reaper_active: Arc::new(AtomicBool::new(false)),
            recovered_sessions,
        })
    }

    pub async fn recording_snapshot(&self) -> Option<RecordingSnapshot> {
        self.recording
            .lock()
            .await
            .as_ref()
            .map(RecordingRuntime::snapshot)
    }

    pub async fn set_synthesis_engine(&self, engine: Arc<dyn SynthesisEngine>) {
        *self.synthesis.write().await = engine;
    }

    pub async fn set_ocr_engine(&self, engine: Arc<dyn OcrEngine>) {
        *self.ocr.write().await = engine;
    }

    /// Re-discover installed GGUF/SLM weights and hot-swap `self.synthesis`
    /// without restarting the application.
    pub async fn refresh_synthesis_engine(&self, preferred_model_id: Option<&str>) -> String {
        let old = self.synthesis.read().await.clone();
        let _ = old.unload().await;

        let next = crate::synthesis::sidecar::sidecar_for_model(
            &self.brand,
            &self.paths.models_dir,
            &self.hardware,
            preferred_model_id,
            Some(self.is_recording.clone()),
        )
        .unwrap_or_else(|| Arc::new(UnavailableEngine) as Arc<dyn SynthesisEngine>);
        let engine_id = next.engine_id().to_string();
        *self.synthesis.write().await = next;
        engine_id
    }

    pub async fn unload_active_models(&self) {
        let synthesis = self.synthesis.read().await.clone();
        let _ = synthesis.unload().await;
        let mut asr = self.asr.lock().await;
        if let Some(cached) = asr.take() {
            tracing::info!(
                model_id = %cached.model_id,
                "explicitly unloaded ASR model from memory"
            );
        }
    }

    pub fn request_asr_cancel(&self) {
        self.asr_cancelled.store(true, Ordering::SeqCst);
    }
}

pub type StateParts = (Brand, Arc<dyn ScreenCapture>, Arc<dyn SynthesisEngine>);

pub fn production_state_parts() -> AppResult<StateParts> {
    // Graceful fallback: a malformed runtime `brand.override.json` must log and
    // fall back to the embedded manifest rather than crashing app startup.
    let brand = match Brand::load(None) {
        Ok(brand) => brand,
        Err(error) => {
            let embedded = Brand::embedded()?;
            if let Ok(paths) = embedded.paths() {
                init_logging(&paths.cache_dir);
            }
            tracing::error!(
                error = %error,
                "invalid runtime brand.override.json; falling back to embedded brand manifest"
            );
            embedded
        }
    };
    let paths = brand.paths()?;
    let hardware = HardwareProfile::detect();
    let synthesis =
        crate::synthesis::sidecar::sidecar_from_brand(&brand, &paths.models_dir, &hardware, None)
            .unwrap_or_else(|| Arc::new(UnavailableEngine) as Arc<dyn SynthesisEngine>);
    Ok((brand, Arc::from(default_backend()), synthesis))
}
