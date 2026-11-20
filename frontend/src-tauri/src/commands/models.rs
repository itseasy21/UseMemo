use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::events;
use crate::model_registry::{catalog, HardwareProfile, ModelArtifact, ModelRole};
use crate::models::{DownloadProgress, DownloadReport};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub artifact: ModelArtifact,
    pub installed: bool,
    pub installed_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHubResponse {
    pub hardware: HardwareProfile,
    pub models: Vec<ModelStatus>,
}

#[tauri::command]
pub fn list_models(state: State<'_, AppState>) -> ModelHubResponse {
    let models = catalog(&state.brand.manifest().model_registry, &state.hardware)
        .into_iter()
        .map(|artifact| {
            let installed = artifact.is_installed(&state.paths.models_dir);
            let installed_bytes = artifact
                .files
                .iter()
                .filter_map(|file| {
                    let path = artifact.local_path(&state.paths.models_dir, &file.filename);
                    std::fs::metadata(path).ok().map(|meta| meta.len())
                })
                .sum();
            ModelStatus {
                artifact,
                installed,
                installed_bytes,
            }
        })
        .collect();
    ModelHubResponse {
        hardware: state.hardware.clone(),
        models,
    }
}

#[tauri::command]
pub fn probe_hardware(state: State<'_, AppState>) -> HardwareProfile {
    state.hardware.clone()
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    artifact_id: String,
) -> AppResult<Vec<DownloadReport>> {
    if state.brand.manifest().features.air_gapped_enforcement
        && std::env::var("MEMO_STRICT_AIRGAP").as_deref() == Ok("1")
    {
        return Err(AppError::Download(
            "strict air-gapped policy is active: stage SHA-256 verified weights in your local models directory instead of downloading over HTTPS"
                .into(),
        ));
    }
    let artifact = find_artifact(&state, &artifact_id)?;
    let mut reports = Vec::with_capacity(artifact.files.len());
    for file in &artifact.files {
        let report = state
            .models
            .download(&artifact, file, |progress: DownloadProgress| {
                let _ = events::emit(&app, events::MODELS_DOWNLOAD_PROGRESS, progress);
            })
            .await?;
        reports.push(report);
    }

    if matches!(artifact.role, ModelRole::Slm | ModelRole::ProSlm) {
        let engine_id = state.refresh_synthesis_engine(Some(&artifact.id)).await;
        tracing::info!(
            artifact_id = %artifact.id,
            engine_id = %engine_id,
            "hot-swapped synthesis engine after model installation"
        );
    }

    Ok(reports)
}

#[tauri::command]
pub async fn cancel_model_download(
    state: State<'_, AppState>,
    artifact_id: String,
) -> AppResult<bool> {
    Ok(state.models.cancel(&artifact_id).await)
}

#[tauri::command]
pub async fn delete_model(state: State<'_, AppState>, artifact_id: String) -> AppResult<u64> {
    let artifact = find_artifact(&state, &artifact_id)?;
    let _ = state.models.cancel(&artifact_id).await;
    let mut removed = 0u64;
    for file in &artifact.files {
        let path = artifact.local_path(&state.paths.models_dir, &file.filename);
        if !path.starts_with(&state.paths.models_dir) {
            return Err(AppError::Invalid(
                "model path escapes the models directory".into(),
            ));
        }
        if path.is_file() {
            removed += std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            std::fs::remove_file(&path)?;
        }
        let partial = crate::models::partial_path(&path);
        if partial.is_file() {
            std::fs::remove_file(&partial)?;
        }
    }

    match artifact.role {
        ModelRole::Asr | ModelRole::FallbackAsr => {
            let mut cached = state.asr.lock().await;
            if cached.as_ref().is_some_and(|c| c.model_id == artifact.id) {
                *cached = None;
            }
        }
        ModelRole::Slm | ModelRole::ProSlm => {
            let engine_id = state.refresh_synthesis_engine(None).await;
            tracing::info!(
                artifact_id = %artifact.id,
                engine_id = %engine_id,
                "refreshed synthesis engine after deleting model"
            );
        }
        ModelRole::DiarizationSegmentation | ModelRole::SpeakerEmbedding => {}
    }

    Ok(removed)
}

#[tauri::command]
pub async fn unload_models(state: State<'_, AppState>) -> AppResult<()> {
    state.unload_active_models().await;
    Ok(())
}

fn find_artifact(state: &AppState, artifact_id: &str) -> AppResult<ModelArtifact> {
    catalog(&state.brand.manifest().model_registry, &state.hardware)
        .into_iter()
        .find(|artifact| artifact.id == artifact_id)
        .ok_or_else(|| AppError::not_found(format!("model artifact {artifact_id}")))
}
