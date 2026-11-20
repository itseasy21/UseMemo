use serde::Serialize;
use tauri::State;

use crate::brand::BrandManifest;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandConfigResponse {
    pub brand_id: String,
    pub product_name: String,
    pub tagline: String,
    pub company_name: String,
    pub bundle_identifier: String,
    pub deep_link_scheme: String,
    pub storage_dir_name: String,
    pub sqlite_file_name: String,
    pub license_type: String,
    pub data_dir: String,
    pub models_dir: String,
    pub exports_dir: String,
    pub override_applied: bool,
    pub manifest_json: String,
}

#[tauri::command]
pub fn get_brand_config(state: State<'_, AppState>) -> BrandConfigResponse {
    let manifest = state.brand.manifest();
    BrandConfigResponse {
        brand_id: manifest.brand_id.clone(),
        product_name: manifest.product_name.clone(),
        tagline: manifest.tagline.clone(),
        company_name: manifest.company_name.clone(),
        bundle_identifier: manifest.bundle_identifier.clone(),
        deep_link_scheme: manifest.deep_link_scheme.clone(),
        storage_dir_name: manifest.storage_dir_name.clone(),
        sqlite_file_name: manifest.sqlite_file_name.clone(),
        license_type: manifest.license_type.clone(),
        data_dir: state.paths.data_dir.to_string_lossy().into_owned(),
        models_dir: state.paths.models_dir.to_string_lossy().into_owned(),
        exports_dir: state.paths.exports_dir.to_string_lossy().into_owned(),
        override_applied: state.brand.override_applied(),
        manifest_json: serde_json::to_string_pretty(manifest)
            .unwrap_or_else(|_| crate::generated_brand::BRAND_MANIFEST_JSON.to_string()),
    }
}

#[tauri::command]
pub fn get_brand_manifest(state: State<'_, AppState>) -> BrandManifest {
    state.brand.manifest().clone()
}
