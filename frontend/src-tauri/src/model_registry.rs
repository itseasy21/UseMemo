use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::brand::ModelRegistry;
use crate::error::{AppError, AppResult};

pub const GIB: u64 = 1024 * 1024 * 1024;
pub const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HardwareTier {
    Low,
    Mid,
    High,
}

impl HardwareTier {
    pub fn from_ram_bytes(ram_bytes: u64) -> Self {
        match ram_bytes {
            bytes if bytes >= 16 * GIB => Self::High,
            bytes if bytes >= 8 * GIB => Self::Mid,
            _ => Self::Low,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Mid => "mid",
            Self::High => "high",
        }
    }

    pub fn keep_asr_warm(self) -> bool {
        matches!(self, Self::Mid | Self::High)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub tier: HardwareTier,
    pub ram_bytes: u64,
    pub ram_gb: f64,
    pub arch: String,
    pub os: String,
    pub accelerator: String,
    pub metal: bool,
    pub vulkan: bool,
    pub xnnpack_cpu: bool,
    pub npu: String,
}

impl HardwareProfile {
    pub fn detect() -> Self {
        let ram_bytes = detect_ram_bytes().unwrap_or(0);
        let arch = std::env::consts::ARCH.to_string();
        let os = std::env::consts::OS.to_string();
        let metal = os == "macos" && arch == "aarch64";
        let npu = if metal { "apple-neural-engine" } else { "unknown" }.to_string();
        let accelerator = if metal {
            "Metal FP16"
        } else {
            "XNNPACK CPU"
        };
        Self {
            tier: HardwareTier::from_ram_bytes(ram_bytes),
            ram_bytes,
            ram_gb: (ram_bytes as f64 / GIB as f64 * 10.0).round() / 10.0,
            arch,
            os,
            accelerator: accelerator.to_string(),
            metal,
            vulkan: false,
            xnnpack_cpu: true,
            npu,
        }
    }

    pub fn with_ram(ram_bytes: u64) -> Self {
        let mut profile = Self::detect();
        profile.ram_bytes = ram_bytes;
        profile.ram_gb = (ram_bytes as f64 / GIB as f64 * 10.0).round() / 10.0;
        profile.tier = HardwareTier::from_ram_bytes(ram_bytes);
        profile
    }
}

fn detect_ram_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        output.status.success().then_some(())?;
        String::from_utf8_lossy(&output.stdout).trim().parse().ok()
    }
    #[cfg(target_os = "linux")]
    {
        let contents = std::fs::read_to_string("/proc/meminfo").ok()?;
        let line = contents.lines().find(|line| line.starts_with("MemTotal:"))?;
        let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kib * 1024)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    Asr,
    FallbackAsr,
    DiarizationSegmentation,
    SpeakerEmbedding,
    Slm,
    ProSlm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub filename: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArtifact {
    pub id: String,
    pub role: ModelRole,
    pub repo: String,
    pub files: Vec<ModelFile>,
    pub description: String,
    pub min_ram_gb: u32,
    pub recommended: bool,
    pub accelerator: String,
}

impl ModelArtifact {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size_bytes).sum()
    }

    pub fn download_url(&self, base_url: &str, filename: &str) -> String {
        format!(
            "{}/{}/resolve/main/{}?download=true",
            base_url.trim_end_matches('/'),
            self.repo,
            filename
        )
    }

    pub fn local_path(&self, models_dir: &Path, filename: &str) -> PathBuf {
        models_dir.join(&self.repo).join(filename)
    }

    pub fn is_installed(&self, models_dir: &Path) -> bool {
        self.files.iter().all(|file| {
            let path = self.local_path(models_dir, &file.filename);
            path.is_file()
                && std::fs::metadata(&path)
                    .map(|meta| meta.len() == file.size_bytes)
                    .unwrap_or(false)
        })
    }
}

pub fn parakeet() -> ModelFile {
    ModelFile {
        filename: "parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm".into(),
        size_bytes: 615 * 1024 * 1024,
        sha256: None,
    }
}

pub fn whisper_tiny() -> ModelFile {
    ModelFile {
        filename: "whisper_tiny_30s_i8.litertlm".into(),
        size_bytes: 43_830_477,
        sha256: None,
    }
}

pub fn diarization_segmentation() -> ModelFile {
    ModelFile {
        filename: "pyannote_seg30.onnx".into(),
        size_bytes: 6_207_569,
        sha256: None,
    }
}

pub fn speaker_embedding() -> ModelFile {
    ModelFile {
        filename: "wespeaker_emb_fp16.tflite".into(),
        size_bytes: 14_050_918,
        sha256: None,
    }
}

pub fn gemma_e2b() -> ModelFile {
    ModelFile {
        filename: "gemma-4-E2B-it.litertlm".into(),
        size_bytes: 2_600_000_000,
        sha256: None,
    }
}

pub fn gemma_e4b() -> ModelFile {
    ModelFile {
        filename: "gemma-4-E4B-it.litertlm".into(),
        size_bytes: 3_554_007_449,
        sha256: None,
    }
}

/// Full catalog for the model hub. Sizes are approximate download sizes used for
/// preflight checks; exact hashes are populated by the Hugging Face manifest when
/// available, otherwise the downloader records the observed digest.
pub fn catalog(registry: &ModelRegistry, hardware: &HardwareProfile) -> Vec<ModelArtifact> {
    let recommended_slm = if hardware.tier == HardwareTier::High {
        registry.pro_slm_repo.clone()
    } else {
        registry.default_slm_repo.clone()
    };
    let recommended_asr = if hardware.tier == HardwareTier::Low {
        registry.fallback_asr_repo.clone()
    } else {
        registry.default_asr_repo.clone()
    };

    vec![
        ModelArtifact {
            id: "parakeet-tdt-0.6b-v3".into(),
            role: ModelRole::Asr,
            repo: registry.default_asr_repo.clone(),
            files: vec![parakeet()],
            description: "INT8 FastConformer-TDT, 25 languages, native punctuation and timestamps".into(),
            min_ram_gb: 8,
            recommended: recommended_asr == registry.default_asr_repo,
            accelerator: "XNNPACK CPU / GPU".into(),
        },
        ModelArtifact {
            id: "whisper-tiny".into(),
            role: ModelRole::FallbackAsr,
            repo: registry.fallback_asr_repo.clone(),
            files: vec![whisper_tiny()],
            description: "INT8 39M encoder-decoder, 30s windows, ultra-low RAM fallback".into(),
            min_ram_gb: 4,
            recommended: recommended_asr == registry.fallback_asr_repo,
            accelerator: "XNNPACK CPU".into(),
        },
        ModelArtifact {
            id: "speaker-diarization-lite".into(),
            role: ModelRole::DiarizationSegmentation,
            repo: registry.diarization_repo.clone(),
            files: vec![diarization_segmentation(), speaker_embedding()],
            description: "pyannote 30s segmentation + WeSpeaker FP16 256-dim speaker embeddings".into(),
            min_ram_gb: 4,
            recommended: true,
            accelerator: "XNNPACK CPU".into(),
        },
        ModelArtifact {
            id: "gemma-4-e2b-it".into(),
            role: ModelRole::Slm,
            repo: registry.default_slm_repo.clone(),
            files: vec![gemma_e2b()],
            description: "QAT INT4, 32k context, text + vision synthesis for 8-15 GB systems".into(),
            min_ram_gb: 8,
            recommended: recommended_slm == registry.default_slm_repo,
            accelerator: "Metal / Vulkan / XNNPACK".into(),
        },
        ModelArtifact {
            id: "gemma-4-e4b-it".into(),
            role: ModelRole::ProSlm,
            repo: registry.pro_slm_repo.clone(),
            files: vec![gemma_e4b()],
            description: "Higher-reasoning QAT INT4 SLM for 16 GB+ hosts".into(),
            min_ram_gb: 16,
            recommended: recommended_slm == registry.pro_slm_repo,
            accelerator: "Metal / Vulkan / XNNPACK".into(),
        },
    ]
}

pub fn recommended_artifacts(registry: &ModelRegistry, hardware: &HardwareProfile) -> Vec<ModelArtifact> {
    catalog(registry, hardware).into_iter().filter(|artifact| artifact.recommended).collect()
}

/// Resolve a model artifact from the registry by role, honoring hardware tier for
/// ASR/SLM selection. Used by the session start command.
pub fn artifact_for_role(
    registry: &ModelRegistry,
    hardware: &HardwareProfile,
    role: ModelRole,
) -> AppResult<ModelArtifact> {
    let selected = match role {
        ModelRole::Asr if hardware.tier == HardwareTier::Low => ModelRole::FallbackAsr,
        ModelRole::Slm if hardware.tier == HardwareTier::High => ModelRole::ProSlm,
        explicit => explicit,
    };
    catalog(registry, hardware)
        .into_iter()
        .find(|artifact| artifact.role == selected)
        .ok_or_else(|| AppError::NotFound(format!("model artifact for role {selected:?}")))
}

/// Validate a user-supplied filename before it reaches the filesystem.
pub fn safe_model_filename(filename: &str) -> AppResult<&str> {
    let valid = !filename.is_empty()
        && !filename.contains(['/', '\\'])
        && !filename.contains("..")
        && filename
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if valid {
        Ok(filename)
    } else {
        Err(AppError::Invalid(format!("unsafe model filename: {filename}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand::Brand;

    fn registry() -> ModelRegistry {
        Brand::embedded().unwrap().manifest().model_registry.clone()
    }

    #[test]
    fn tier_boundaries_match_the_hardware_policy() {
        assert_eq!(HardwareTier::from_ram_bytes(4 * GIB), HardwareTier::Low);
        assert_eq!(HardwareTier::from_ram_bytes(8 * GIB), HardwareTier::Mid);
        assert_eq!(HardwareTier::from_ram_bytes(12 * GIB), HardwareTier::Mid);
        assert_eq!(HardwareTier::from_ram_bytes(16 * GIB), HardwareTier::High);
        assert!(!HardwareTier::Low.keep_asr_warm());
        assert!(HardwareTier::High.keep_asr_warm());
    }

    #[test]
    fn low_tier_selects_whisper_and_e2b() {
        let hardware = HardwareProfile::with_ram(4 * GIB);
        let recommended = recommended_artifacts(&registry(), &hardware);
        let ids: Vec<_> = recommended.iter().map(|artifact| artifact.id.as_str()).collect();
        assert!(ids.contains(&"whisper-tiny"));
        assert!(ids.contains(&"gemma-4-e2b-it"));
        assert!(!ids.contains(&"parakeet-tdt-0.6b-v3"));
    }

    #[test]
    fn high_tier_selects_parakeet_and_e4b() {
        let hardware = HardwareProfile::with_ram(32 * GIB);
        let recommended = recommended_artifacts(&registry(), &hardware);
        let ids: Vec<_> = recommended.iter().map(|artifact| artifact.id.as_str()).collect();
        assert!(ids.contains(&"parakeet-tdt-0.6b-v3"));
        assert!(ids.contains(&"gemma-4-e4b-it"));
    }

    #[test]
    fn artifact_urls_and_paths_are_well_formed() {
        let hardware = HardwareProfile::with_ram(32 * GIB);
        let parakeet = artifact_for_role(&registry(), &hardware, ModelRole::Asr).unwrap();
        assert_eq!(parakeet.total_bytes(), 615 * MIB);
        assert_eq!(
            parakeet.download_url("https://huggingface.co/", &parakeet.files[0].filename),
            "https://huggingface.co/litert-community/parakeet-tdt-0.6b-v3/resolve/main/parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm?download=true"
        );
        assert_eq!(
            parakeet.local_path(Path::new("/models"), &parakeet.files[0].filename),
            PathBuf::from("/models/litert-community/parakeet-tdt-0.6b-v3/parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm")
        );
    }

    #[test]
    fn fallback_role_resolves_to_whisper() {
        let hardware = HardwareProfile::with_ram(32 * GIB);
        let whisper = artifact_for_role(&registry(), &hardware, ModelRole::FallbackAsr).unwrap();
        assert_eq!(whisper.id, "whisper-tiny");
    }

    #[test]
    fn unsafe_filenames_are_rejected() {
        assert!(safe_model_filename("model.litertlm").is_ok());
        assert!(safe_model_filename("../escape.litertlm").is_err());
        assert!(safe_model_filename("a/b.bin").is_err());
        assert!(safe_model_filename("").is_err());
    }
}
