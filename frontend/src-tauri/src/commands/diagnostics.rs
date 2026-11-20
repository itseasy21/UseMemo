use std::path::PathBuf;

use chrono::Utc;
use serde::Serialize;
use tauri::State;

use crate::commands::meetings::{audio_capabilities, AudioCapabilities};
use crate::error::AppResult;
use crate::logging::{active_log_dir, read_recent_logs};
use crate::model_registry::{catalog, HardwareProfile};
use crate::state::AppState;
use crate::storage::VaultCounts;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiagnostic {
    pub id: String,
    pub repo: String,
    pub installed: bool,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundle {
    pub generated_at: String,
    pub brand_id: String,
    pub product_name: String,
    pub bundle_identifier: String,
    pub override_applied: bool,
    pub synthesis_engine_id: String,
    pub hardware: HardwareProfile,
    pub audio_capabilities: AudioCapabilities,
    pub models: Vec<ModelDiagnostic>,
    pub vault_counts: VaultCounts,
    pub recovered_sessions_on_boot: usize,
    pub logs_dir: String,
    pub recent_logs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDiagnosticsOutcome {
    pub path: String,
    pub bytes: u64,
    pub log_lines: usize,
}

async fn collect_bundle(state: &AppState, log_limit: usize) -> AppResult<DiagnosticsBundle> {
    let manifest = state.brand.manifest();
    let models = catalog(&manifest.model_registry, &state.hardware)
        .into_iter()
        .map(|artifact| ModelDiagnostic {
            installed: artifact.is_installed(&state.paths.models_dir),
            total_bytes: artifact.total_bytes(),
            id: artifact.id,
            repo: artifact.repo,
        })
        .collect();
    let synthesis_engine_id = state.synthesis.read().await.engine_id().to_string();
    let vault_counts = state.db.vault_counts().await?;
    let logs_dir = active_log_dir(&state.paths.cache_dir);
    let recent_logs = read_recent_logs(&state.paths.cache_dir, log_limit);

    Ok(DiagnosticsBundle {
        generated_at: Utc::now().to_rfc3339(),
        brand_id: manifest.brand_id.clone(),
        product_name: manifest.product_name.clone(),
        bundle_identifier: manifest.bundle_identifier.clone(),
        override_applied: state.brand.override_applied(),
        synthesis_engine_id,
        hardware: state.hardware.clone(),
        audio_capabilities: audio_capabilities(),
        models,
        vault_counts,
        recovered_sessions_on_boot: state.recovered_sessions,
        logs_dir: logs_dir.to_string_lossy().into_owned(),
        recent_logs,
    })
}

#[tauri::command]
pub async fn get_diagnostics_summary(state: State<'_, AppState>) -> AppResult<DiagnosticsBundle> {
    collect_bundle(&state, 100).await
}

/// Write a sanitized offline support bundle JSON containing zero meeting text,
/// notes, or transcripts so B2B deployments can share diagnostics safely.
#[tauri::command]
pub async fn export_diagnostics(
    state: State<'_, AppState>,
    destination_dir: Option<String>,
) -> AppResult<ExportDiagnosticsOutcome> {
    let bundle = collect_bundle(&state, 500).await?;
    let log_lines = bundle.recent_logs.len();
    let out_dir = destination_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.paths.exports_dir.join("diagnostics"));

    let serialized = serde_json::to_vec_pretty(&bundle)?;
    let filename = format!(
        "{}-diagnostics-{}.json",
        state.brand.manifest().brand_id,
        Utc::now().format("%Y%m%d-%H%M%S")
    );
    let target = out_dir.join(filename);
    let write_target = target.clone();
    let bytes = serialized.len() as u64;
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        std::fs::create_dir_all(&out_dir)?;
        std::fs::write(&write_target, serialized)?;
        Ok(())
    })
    .await
    .map_err(|error| {
        crate::error::AppError::Invalid(format!("diagnostics write task failed: {error}"))
    })??;

    tracing::info!(path = %target.display(), bytes, "exported sanitized diagnostics bundle");
    Ok(ExportDiagnosticsOutcome {
        path: target.to_string_lossy().into_owned(),
        bytes,
        log_lines,
    })
}
