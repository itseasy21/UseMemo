use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::generated_brand;

/// Full build-time brand contract. Mirrors `brand/brand.config.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandManifest {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub brand_id: String,
    pub product_name: String,
    pub tagline: String,
    pub company_name: String,
    pub bundle_identifier: String,
    pub binary_name: String,
    pub deep_link_scheme: String,
    pub storage_dir_name: String,
    pub sqlite_file_name: String,
    pub license_type: String,
    pub assets: BrandAssets,
    pub theme: BrandTheme,
    pub features: BrandFeatures,
    pub model_registry: ModelRegistry,
    /// Runtime-only additive section. Not present in the shipped base manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<PromptTemplates>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandAssets {
    pub app_icon_svg: String,
    pub tray_icon_monochrome: String,
    pub wordmark_dark: String,
    pub wordmark_light: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandTheme {
    pub default_mode: ThemeMode,
    pub radius: String,
    pub font_sans: String,
    pub font_mono: String,
    pub tokens: ThemeTokenSet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Dark,
    #[default]
    Light,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeTokenSet {
    pub dark: ThemeTokens,
    pub light: ThemeTokens,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeTokens {
    pub bg_primary: String,
    pub bg_elevated: String,
    pub bg_glass: String,
    pub border_subtle: String,
    pub text_primary: String,
    pub text_muted: String,
    pub accent_primary: String,
    pub accent_secondary: String,
    pub recording_pulse: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandFeatures {
    pub air_gapped_enforcement: bool,
    pub enable_periodic_screenshots: bool,
    pub default_screenshot_interval_sec: u32,
    #[serde(rename = "enableSlideVisionOCR", alias = "enableSlideVisionOcr")]
    pub enable_slide_vision_ocr: bool,
    pub enable_voiceprint_enrollment: bool,
    pub enable_gnu_keybindings: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRegistry {
    pub hf_base_url: String,
    pub default_asr_repo: String,
    pub fallback_asr_repo: String,
    pub diarization_repo: String,
    pub default_slm_repo: String,
    pub pro_slm_repo: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplates {
    #[serde(default)]
    pub synthesis_system: Option<String>,
    #[serde(default)]
    pub slide_ocr: Option<String>,
}

/// Resolved application directories for a brand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrandPaths {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub media_dir: PathBuf,
    pub models_dir: PathBuf,
    pub exports_dir: PathBuf,
    pub db_path: PathBuf,
    pub brand_override_path: PathBuf,
}

impl BrandPaths {
    pub fn for_manifest(manifest: &BrandManifest) -> AppResult<Self> {
        let data_root = dirs::data_dir()
            .ok_or_else(|| AppError::Invalid("OS application data directory is unavailable".into()))?;
        let cache_root = dirs::cache_dir()
            .ok_or_else(|| AppError::Invalid("OS application cache directory is unavailable".into()))?;
        Ok(Self::from_roots(manifest, data_root, cache_root))
    }

    pub fn from_roots(manifest: &BrandManifest, data_root: PathBuf, cache_root: PathBuf) -> Self {
        let data_dir = data_root.join(&manifest.storage_dir_name);
        let cache_dir = cache_root.join(&manifest.storage_dir_name);
        Self {
            media_dir: data_dir.join("media"),
            models_dir: data_dir.join("models"),
            exports_dir: data_dir.join("exports"),
            db_path: data_dir.join(&manifest.sqlite_file_name),
            brand_override_path: data_dir.join("brand.override.json"),
            data_dir,
            cache_dir,
        }
    }

    pub fn ensure(&self) -> AppResult<()> {
        for dir in [
            &self.data_dir,
            &self.cache_dir,
            &self.media_dir,
            &self.models_dir,
            &self.exports_dir,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn meeting_media_dir(&self, meeting_id: &str) -> PathBuf {
        self.media_dir.join(sanitize_path_component(meeting_id))
    }

    pub fn meeting_shots_dir(&self, meeting_id: &str) -> PathBuf {
        self.meeting_media_dir(meeting_id).join("shots")
    }
}

fn sanitize_path_component(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// Runtime brand bundle: embedded manifest plus an optional enterprise override.
#[derive(Debug, Clone)]
pub struct Brand {
    manifest: BrandManifest,
    override_applied: bool,
}

const OVERRIDABLE_KEYS: &[&str] = &["productName", "tagline", "theme", "assets", "features", "prompts"];

impl Brand {
    /// Load the embedded manifest. If `override_path` is provided (or the default
    /// per-brand path exists when `None`), apply the restricted enterprise override.
    pub fn load(override_path: Option<&Path>) -> AppResult<Self> {
        let manifest: BrandManifest = serde_json::from_str(generated_brand::BRAND_MANIFEST_JSON)?;
        validate(&manifest)?;

        let default_path;
        let path = match override_path {
            Some(path) => Some(path),
            None => {
                let paths = BrandPaths::for_manifest(&manifest)?;
                default_path = paths.brand_override_path;
                if default_path.is_file() {
                    Some(default_path.as_path())
                } else {
                    None
                }
            }
        };

        match path {
            Some(path) if path.is_file() => {
                let raw = std::fs::read_to_string(path)?;
                let overlay: serde_json::Value = serde_json::from_str(&raw)?;
                let merged = apply_override(&manifest, overlay)?;
                Ok(Self { manifest: merged, override_applied: true })
            }
            _ => Ok(Self { manifest, override_applied: false }),
        }
    }

    pub fn embedded() -> AppResult<Self> {
        Self::load(Some(Path::new("/__no_runtime_brand_override__")))
    }

    pub fn manifest(&self) -> &BrandManifest {
        &self.manifest
    }

    pub fn override_applied(&self) -> bool {
        self.override_applied
    }

    pub fn paths(&self) -> AppResult<BrandPaths> {
        BrandPaths::for_manifest(&self.manifest)
    }

    pub fn prompts(&self) -> PromptTemplates {
        self.manifest.prompts.clone().unwrap_or_default()
    }
}

/// Applies only allow-listed top-level keys. Identity and storage fields are
/// immutable at runtime so an override can never redirect the vault or updater.
pub fn apply_override(manifest: &BrandManifest, overlay: serde_json::Value) -> AppResult<BrandManifest> {
    let overlay_object = overlay
        .as_object()
        .ok_or_else(|| AppError::Invalid("brand.override.json must be a JSON object".into()))?;

    let mut base = serde_json::to_value(manifest)?;
    let base_object = base
        .as_object_mut()
        .ok_or_else(|| AppError::Invalid("embedded brand manifest is not an object".into()))?;

    for key in OVERRIDABLE_KEYS {
        if let Some(value) = overlay_object.get(*key) {
            match (base_object.get_mut(*key), value) {
                (Some(existing), value) if existing.is_object() && value.is_object() => {
                    deep_merge_json(existing, value);
                }
                _ => {
                    base_object.insert((*key).to_string(), value.clone());
                }
            }
        }
    }

    let merged: BrandManifest = serde_json::from_value(base)?;
    validate(&merged)?;
    Ok(merged)
}

fn deep_merge_json(base: &mut serde_json::Value, overlay: &serde_json::Value) {
    match (base, overlay) {
        (serde_json::Value::Object(base_map), serde_json::Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                if let Some(existing) = base_map.get_mut(key) {
                    deep_merge_json(existing, value);
                } else {
                    base_map.insert(key.clone(), value.clone());
                }
            }
        }
        (base, overlay) => *base = overlay.clone(),
    }
}

fn validate(manifest: &BrandManifest) -> AppResult<()> {
    if manifest.brand_id.trim().is_empty() {
        return Err(AppError::Invalid("brandId is empty".into()));
    }
    if manifest.storage_dir_name.contains(['/', '\\']) {
        return Err(AppError::Invalid("storageDirName must not contain path separators".into()));
    }
    if manifest.sqlite_file_name.contains(['/', '\\']) {
        return Err(AppError::Invalid("sqliteFileName must not contain path separators".into()));
    }
    if manifest.theme.tokens.dark.accent_primary.trim().is_empty()
        || manifest.theme.tokens.light.accent_primary.trim().is_empty()
    {
        return Err(AppError::Invalid("theme accent tokens are empty".into()));
    }
    if !(5..=3600).contains(&manifest.features.default_screenshot_interval_sec) {
        return Err(AppError::Invalid(
            "defaultScreenshotIntervalSec must be between 5 and 3600".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn embedded_manifest_parses_and_matches_codegen_constants() {
        let brand = Brand::embedded().expect("embedded brand must parse");
        assert_eq!(brand.manifest().brand_id, generated_brand::BRAND_ID);
        assert_eq!(brand.manifest().product_name, generated_brand::PRODUCT_NAME);
        assert_eq!(brand.manifest().sqlite_file_name, generated_brand::SQLITE_FILE_NAME);
        assert!(!brand.override_applied());
        assert_eq!(
            brand.manifest().theme.tokens.dark.accent_primary,
            generated_brand::THEME_DARK
                .iter()
                .find(|(key, _)| *key == "accentPrimary")
                .unwrap()
                .1
        );
    }

    #[test]
    fn runtime_override_changes_theme_and_prompts_but_not_identity_or_storage() {
        let dir = tempdir().unwrap();
        let override_path = dir.path().join("brand.override.json");
        std::fs::write(
            &override_path,
            serde_json::json!({
                "brandId": "evil",
                "bundleIdentifier": "com.evil.app",
                "storageDirName": "evil-vault",
                "sqliteFileName": "evil.db",
                "productName": "AcmeVault Notes",
                "tagline": "Your notes, your hardware",
                "theme": {
                    "tokens": {
                        "dark": { "accentPrimary": "oklch(0.70 0.20 30)" }
                    }
                },
                "prompts": { "summarySystem": "ignored-extra", "slideOcr": "Extract labels only." },
                "assets": { "wordmarkDark": "/tmp/acme-dark.svg" }
            })
            .to_string(),
        )
        .unwrap();

        let brand = Brand::load(Some(&override_path)).unwrap();
        let manifest = brand.manifest();
        assert!(brand.override_applied());
        assert_eq!(manifest.product_name, "AcmeVault Notes");
        assert_eq!(manifest.theme.tokens.dark.accent_primary, "oklch(0.70 0.20 30)");
        // unaffected token remains inherited
        assert_eq!(
            manifest.theme.tokens.dark.bg_primary,
            generated_brand::THEME_DARK
                .iter()
                .find(|(key, _)| *key == "bgPrimary")
                .unwrap()
                .1
        );
        assert_eq!(manifest.assets.wordmark_dark, "/tmp/acme-dark.svg");
        assert_eq!(manifest.prompts.as_ref().unwrap().slide_ocr.as_deref(), Some("Extract labels only."));
        // immutable identity and vault location
        assert_eq!(manifest.brand_id, generated_brand::BRAND_ID);
        assert_eq!(manifest.bundle_identifier, generated_brand::BUNDLE_IDENTIFIER);
        assert_eq!(manifest.storage_dir_name, generated_brand::STORAGE_DIR_NAME);
        assert_eq!(manifest.sqlite_file_name, generated_brand::SQLITE_FILE_NAME);
    }

    #[test]
    fn malformed_override_is_rejected() {
        let brand = Brand::embedded().unwrap();
        assert!(apply_override(
            brand.manifest(),
            serde_json::json!({"theme": {"tokens": {"dark": {"accentPrimary": ""}}}})
        )
        .is_err());
        assert!(apply_override(brand.manifest(), serde_json::json!([])).is_err());
    }

    #[test]
    fn brand_paths_are_derived_only_from_storage_fields() {
        let brand = Brand::embedded().unwrap();
        let paths = BrandPaths::from_roots(
            brand.manifest(),
            PathBuf::from("/data-root"),
            PathBuf::from("/cache-root"),
        );
        assert_eq!(paths.data_dir, PathBuf::from("/data-root").join(generated_brand::STORAGE_DIR_NAME));
        assert_eq!(paths.db_path, paths.data_dir.join(generated_brand::SQLITE_FILE_NAME));
        assert_eq!(paths.meeting_shots_dir("abc/evil"), paths.media_dir.join("abc-evil").join("shots"));
    }
}
