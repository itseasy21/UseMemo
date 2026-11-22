//! Tauri adapter for the local GGUF / LiteRT synthesis worker process.
//!
//! The process (`memo-litert-worker`, built from `crates/memo-llama-worker`) is
//! spawned lazily on the first synthesis request and kept warm for the session.
//! If the binary or GGUF weights are missing, the app uses `UnavailableEngine`
//! and fails closed with an actionable Model Studio hint.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use memo_litert_bridge::WorkerClient;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::model_registry::{installed_slm_artifact, HardwareProfile, HardwareTier};
use crate::synthesis::orchestrator::{SynthesisEngine, TokenCallback};
use crate::synthesis::types::SynthesisRequest;

pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

pub struct SidecarEngine {
    program: PathBuf,
    model_path: PathBuf,
    backend: String,
    max_seq_len: u32,
    engine_label: String,
    client: Arc<Mutex<Option<WorkerClient>>>,
    last_activity: Arc<Mutex<Instant>>,
    reaper_active: Arc<AtomicBool>,
    is_recording: Arc<AtomicBool>,
}

impl SidecarEngine {
    pub fn new(program: PathBuf, model_path: PathBuf, backend: impl Into<String>) -> Self {
        Self::with_context_len(
            program,
            model_path,
            backend,
            16_384,
            Arc::new(AtomicBool::new(false)),
        )
    }

    pub fn with_context_len(
        program: PathBuf,
        model_path: PathBuf,
        backend: impl Into<String>,
        max_seq_len: u32,
        is_recording: Arc<AtomicBool>,
    ) -> Self {
        let is_gguf = model_path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("gguf"));
        let engine_label = if is_gguf {
            "llama-cpp-gguf".into()
        } else {
            "litert-lm-sidecar".into()
        };
        Self {
            program,
            model_path,
            backend: backend.into(),
            max_seq_len,
            engine_label,
            client: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(Mutex::new(Instant::now())),
            reaper_active: Arc::new(AtomicBool::new(false)),
            is_recording,
        }
    }

    pub async fn warm(&self) -> AppResult<()> {
        self.ensure_client().await.map(|_| ())
    }

    pub async fn unload(&self) -> AppResult<()> {
        let mut guard = self.client.lock().await;
        if let Some(client) = guard.take() {
            tracing::info!(
                model = %self.model_path.display(),
                "unloading synthesis model from memory"
            );
            let _ = client.shutdown().await;
        }
        Ok(())
    }

    async fn ensure_client(&self) -> AppResult<tokio::sync::MutexGuard<'_, Option<WorkerClient>>> {
        *self.last_activity.lock().await = Instant::now();
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
                    Some(self.max_seq_len),
                )
                .await
                .map_err(|error| AppError::Synthesis(error.to_string()))?;
            *guard = Some(client);
            tracing::info!(
                model = %self.model_path.display(),
                engine = %self.engine_label,
                "loaded on-device synthesis model into memory"
            );
        }

        if !self.reaper_active.swap(true, Ordering::SeqCst) {
            let client_ref = Arc::clone(&self.client);
            let last_activity_ref = Arc::clone(&self.last_activity);
            let reaper_active_ref = Arc::clone(&self.reaper_active);
            let is_recording_ref = Arc::clone(&self.is_recording);
            let model_path = self.model_path.clone();

            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    let recording = is_recording_ref.load(Ordering::SeqCst);
                    if recording {
                        continue;
                    }
                    let elapsed = {
                        let last = last_activity_ref.lock().await;
                        last.elapsed()
                    };
                    if elapsed >= DEFAULT_IDLE_TIMEOUT {
                        let mut guard = client_ref.lock().await;
                        let recording = is_recording_ref.load(Ordering::SeqCst);
                        let current_elapsed = {
                            let last = last_activity_ref.lock().await;
                            last.elapsed()
                        };
                        if !recording && current_elapsed >= DEFAULT_IDLE_TIMEOUT {
                            if let Some(client) = guard.take() {
                                tracing::info!(
                                    model = %model_path.display(),
                                    idle_secs = current_elapsed.as_secs(),
                                    "unloading idle synthesis model to release RAM and Metal GPU resources"
                                );
                                let _ = client.shutdown().await;
                            }
                            reaper_active_ref.store(false, Ordering::SeqCst);
                            break;
                        }
                    }
                }
            });
        }

        Ok(guard)
    }
}

#[async_trait]
impl SynthesisEngine for SidecarEngine {
    fn engine_id(&self) -> &str {
        &self.engine_label
    }

    fn model_path(&self) -> Option<&Path> {
        Some(&self.model_path)
    }

    async fn warm(&self) -> AppResult<()> {
        self.ensure_client().await.map(|_| ())
    }

    async fn unload(&self) -> AppResult<()> {
        self.unload().await
    }

    async fn generate(&self, request: SynthesisRequest) -> AppResult<String> {
        self.generate_streaming(request, &|_| {}).await
    }

    async fn generate_streaming(
        &self,
        request: SynthesisRequest,
        on_token: TokenCallback<'_>,
    ) -> AppResult<String> {
        *self.last_activity.lock().await = Instant::now();
        let mut guard = self.ensure_client().await?;
        let client = guard
            .as_mut()
            .ok_or_else(|| AppError::Synthesis("worker client was not initialized".into()))?;
        let result = client
            .generate_with_grammar(
                &request.system,
                &request.user,
                request.temperature,
                request.top_p,
                request.top_k,
                request.max_output_tokens,
                request.grammar,
                |delta| on_token(delta),
            )
            .await;

        *self.last_activity.lock().await = Instant::now();

        if result.is_err() {
            // Reset broken worker handle so the next attempt respawns cleanly.
            if let Some(dead) = guard.take() {
                let _ = dead.kill().await;
            }
        }
        result.map_err(|error| AppError::Synthesis(error.to_string()))
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

fn worker_candidate_names() -> Vec<String> {
    let ext = std::env::consts::EXE_SUFFIX;
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    let triple_hint = match (os, arch) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        _ => "",
    };

    let mut names = vec![
        format!("memo-litert-worker{ext}"),
        format!("litert-lm-worker{ext}"),
    ];
    if !triple_hint.is_empty() {
        names.insert(1, format!("memo-litert-worker-{triple_hint}{ext}"));
    }
    names
}

/// Locate a bundled or workspace-built worker binary.
pub fn discover_worker() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("MEMO_LITERT_WORKER") {
        let path = PathBuf::from(explicit);
        return path.is_file().then_some(path);
    }

    let names = worker_candidate_names();

    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            for candidate in &names {
                let path = directory.join(candidate);
                if path.is_file() {
                    return Some(path);
                }
            }
            // During `cargo test` the test binary sits in `target/debug/deps/`,
            // while `memo-litert-worker` sits one directory up in `target/debug/`.
            if let Some(parent_dir) = directory.parent() {
                for candidate in &names {
                    let path = parent_dir.join(candidate);
                    if path.is_file() {
                        return Some(path);
                    }
                }
            }
        }
    }

    // Fallback to workspace target directories during `tauri dev`.
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let ws_root = Path::new(&manifest_dir).join("../..");
        for profile in ["release", "debug"] {
            for candidate in &names {
                let path = ws_root.join("target").join(profile).join(candidate);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }

    None
}

pub fn sidecar_from_brand(
    brand: &crate::brand::Brand,
    models_dir: &Path,
    hardware: &HardwareProfile,
    is_recording: Option<Arc<AtomicBool>>,
) -> Option<Arc<dyn SynthesisEngine>> {
    sidecar_for_model(brand, models_dir, hardware, None, is_recording)
}

pub fn sidecar_for_model(
    brand: &crate::brand::Brand,
    models_dir: &Path,
    hardware: &HardwareProfile,
    preferred_model_id: Option<&str>,
    is_recording: Option<Arc<AtomicBool>>,
) -> Option<Arc<dyn SynthesisEngine>> {
    let program = discover_worker()?;
    let artifact = installed_slm_artifact(
        &brand.manifest().model_registry,
        models_dir,
        hardware,
        preferred_model_id,
    )?;
    let file = artifact.files.first()?;
    let model_path = artifact.local_path(models_dir, &file.filename);
    if !model_path.is_file() {
        return None;
    }
    let backend = if hardware.metal { "gpu" } else { "cpu" };
    let max_seq_len = if hardware.tier == HardwareTier::High {
        16_384
    } else {
        8_192
    };
    Some(Arc::new(SidecarEngine::with_context_len(
        program,
        model_path,
        backend,
        max_seq_len,
        is_recording.unwrap_or_else(|| Arc::new(AtomicBool::new(false))),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_id_reflects_gguf_or_litert_extension() {
        let gguf = SidecarEngine::new(
            PathBuf::from("/nope"),
            PathBuf::from("/models/qwen.gguf"),
            "gpu",
        );
        assert_eq!(gguf.engine_id(), "llama-cpp-gguf");

        let litert = SidecarEngine::new(
            PathBuf::from("/nope"),
            PathBuf::from("/models/gemma.litertlm"),
            "cpu",
        );
        assert_eq!(litert.engine_id(), "litert-lm-sidecar");
    }

    #[test]
    fn worker_discovery_returns_existing_file_when_found() {
        if let Some(found) = discover_worker() {
            assert!(found.is_file());
        }
    }
}
