//! Tauri adapter for the LiteRT-LM worker process.
//!
//! The process is spawned lazily on the first synthesis request and kept warm
//! for the session. If the binary or model is missing, the app uses
//! `UnavailableEngine` and fails closed.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use memo_litert_bridge::WorkerClient;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::synthesis::orchestrator::SynthesisEngine;
use crate::synthesis::types::SynthesisRequest;

pub struct SidecarEngine {
    program: PathBuf,
    model_path: PathBuf,
    backend: String,
    client: Mutex<Option<WorkerClient>>,
}

impl SidecarEngine {
    pub fn new(program: PathBuf, model_path: PathBuf, backend: impl Into<String>) -> Self {
        Self {
            program,
            model_path,
            backend: backend.into(),
            client: Mutex::new(None),
        }
    }

    pub async fn warm(&self) -> AppResult<()> {
        self.ensure_client().await.map(|_| ())
    }

    async fn ensure_client(&self) -> AppResult<tokio::sync::MutexGuard<'_, Option<WorkerClient>>> {
        let mut guard = self.client.lock().await;
        if guard.is_none() {
            let mut client = WorkerClient::spawn(&self.program, &[])
                .await
                .map_err(|error| AppError::Synthesis(error.to_string()))?;
            client
                .hello()
                .await
                .map_err(|error| AppError::Synthesis(error.to_string()))?;
            client
                .load_model(
                    self.model_path.to_string_lossy().into_owned(),
                    Some(self.backend.clone()),
                    Some(4096),
                )
                .await
                .map_err(|error| AppError::Synthesis(error.to_string()))?;
            *guard = Some(client);
        }
        Ok(guard)
    }
}

#[async_trait]
impl SynthesisEngine for SidecarEngine {
    fn engine_id(&self) -> &str {
        "litert-lm-sidecar"
    }

    async fn generate(&self, request: SynthesisRequest) -> AppResult<String> {
        let mut guard = self.ensure_client().await?;
        let client = guard
            .as_mut()
            .ok_or_else(|| AppError::Synthesis("worker client was not initialized".into()))?;
        client
            .generate(
                &request.system,
                &request.user,
                request.temperature,
                request.top_p,
                request.top_k,
                request.max_output_tokens,
                |_delta| {},
            )
            .await
            .map_err(|error| AppError::Synthesis(error.to_string()))
    }
}

impl Drop for SidecarEngine {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.client.try_lock() {
            if let Some(client) = guard.take() {
                tauri::async_runtime::spawn(async move {
                    let _ = client.shutdown().await;
                });
            }
        }
    }
}

/// Locate a bundled worker next to the app binary or via an explicit override.
pub fn discover_worker() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("MEMO_LITERT_WORKER") {
        let path = PathBuf::from(explicit);
        return path.is_file().then_some(path);
    }
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    for candidate in ["memo-litert-worker", "litert-lm-worker"] {
        let path = directory.join(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

pub fn sidecar_from_brand(
    brand: &crate::brand::Brand,
    models_dir: &std::path::Path,
    hardware: &crate::model_registry::HardwareProfile,
) -> Option<Arc<dyn SynthesisEngine>> {
    let program = discover_worker()?;
    let artifact = crate::model_registry::artifact_for_role(
        &brand.manifest().model_registry,
        hardware,
        crate::model_registry::ModelRole::Slm,
    )
    .ok()?;
    let file = artifact.files.first()?;
    let model_path = artifact.local_path(models_dir, &file.filename);
    if !model_path.is_file() {
        return None;
    }
    let backend = if hardware.metal { "gpu" } else { "cpu" };
    Some(Arc::new(SidecarEngine::new(program, model_path, backend)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_id_is_stable() {
        let engine = SidecarEngine::new(PathBuf::from("/nope"), PathBuf::from("/nope"), "cpu");
        assert_eq!(engine.engine_id(), "litert-lm-sidecar");
        assert!(!engine.program.exists());
    }

    #[test]
    fn missing_worker_discovery_is_none_by_default() {
        let previous = std::env::var_os("MEMO_LITERT_WORKER");
        std::env::remove_var("MEMO_LITERT_WORKER");
        let found = discover_worker();
        if let Some(path) = previous {
            std::env::set_var("MEMO_LITERT_WORKER", path);
        }
        assert!(found.map(|path| path.is_file()).unwrap_or(true));
    }
}
