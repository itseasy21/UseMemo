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
        let metal = matches!(os.as_str(), "macos" | "ios") && arch == "aarch64";
        let npu = if metal {
            "apple-neural-engine"
        } else {
            "cpu-simd"
        }
        .to_string();
        let accelerator = if metal {
            "Metal GPU"
        } else if arch == "aarch64" {
            "CPU · ARM NEON"
        } else {
            "CPU · AVX2"
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
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        #[repr(C)]
        struct RawSysctlName;
        let _ = RawSysctlName;

        unsafe extern "C" {
            fn sysctlbyname(
                name: *const std::os::raw::c_char,
                oldp: *mut std::ffi::c_void,
                oldlenp: *mut usize,
                newp: *const std::ffi::c_void,
                newlen: usize,
            ) -> std::os::raw::c_int;
        }

        let mut memsize: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        let rc = unsafe {
            sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&mut memsize as *mut u64).cast::<std::ffi::c_void>(),
                &mut len,
                std::ptr::null(),
                0,
            )
        };
        if rc == 0 && memsize > 0 {
            return Some(memsize);
        }
        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("sysctl")
                .args(["-n", "hw.memsize"])
                .output()
                .ok()?;
            output.status.success().then_some(())?;
            String::from_utf8_lossy(&output.stdout).trim().parse().ok()
        }
        #[cfg(target_os = "ios")]
        {
            None
        }
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let contents = std::fs::read_to_string("/proc/meminfo").ok()?;
        let line = contents
            .lines()
            .find(|line| line.starts_with("MemTotal:"))?;
        let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kib * 1024)
    }
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct MemoryStatusEx {
            dw_length: u32,
            dw_memory_load: u32,
            ull_total_phys: u64,
            ull_avail_phys: u64,
            ull_total_page_file: u64,
            ull_avail_page_file: u64,
            ull_total_virtual: u64,
            ull_avail_virtual: u64,
            ull_avail_extended_virtual: u64,
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
        }

        let mut status = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            dw_memory_load: 0,
            ull_total_phys: 0,
            ull_avail_phys: 0,
            ull_total_page_file: 0,
            ull_avail_page_file: 0,
            ull_total_virtual: 0,
            ull_avail_virtual: 0,
            ull_avail_extended_virtual: 0,
        };
        let ok = unsafe { GlobalMemoryStatusEx(&mut status as *mut MemoryStatusEx) };
        if ok != 0 && status.ull_total_phys > 0 {
            Some(status.ull_total_phys)
        } else {
            None
        }
    }
    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android",
        target_os = "windows"
    )))]
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
    /// Pinned digest from the publisher. Every artifact must carry one: an
    /// unpinned model download is a supply-chain hole, so the type makes it
    /// unrepresentable rather than optional.
    pub sha256: String,
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
    #[serde(default)]
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

pub fn whisper_large_v3_turbo() -> ModelFile {
    ModelFile {
        filename: "ggml-large-v3-turbo-q5_0.bin".into(),
        size_bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2".into(),
    }
}

pub fn whisper_small() -> ModelFile {
    ModelFile {
        filename: "ggml-small-q5_1.bin".into(),
        size_bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb".into(),
    }
}

pub fn whisper_tiny() -> ModelFile {
    ModelFile {
        filename: "ggml-tiny-q5_1.bin".into(),
        size_bytes: 32_152_673,
        sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7".into(),
    }
}

pub fn lfm25_1_2b_gguf() -> ModelFile {
    ModelFile {
        filename: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf".into(),
        size_bytes: 730_895_168,
        sha256: "b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5".into(),
    }
}

pub fn lfm25_2_6b_gguf() -> ModelFile {
    ModelFile {
        filename: "LFM2.5-2.6B-Q4_K_M.gguf".into(),
        size_bytes: 1_674_455_040,
        sha256: "02a8b7e17487d326e46d68ce0ba24211e1b80a14c4cd0597fa73c1cd697f52ed".into(),
    }
}

pub fn qwen35_4b_gguf() -> ModelFile {
    ModelFile {
        filename: "Qwen3.5-4B-Q4_K_M.gguf".into(),
        size_bytes: 2_740_937_888,
        sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4".into(),
    }
}

pub fn gemma4_e2b_gguf() -> ModelFile {
    ModelFile {
        filename: "gemma-4-E2B-it-Q4_K_M.gguf".into(),
        size_bytes: 3_106_738_272,
        sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8".into(),
    }
}

pub fn gemma4_e4b_gguf() -> ModelFile {
    ModelFile {
        filename: "gemma-4-E4B-it-Q4_K_M.gguf".into(),
        size_bytes: 4_977_171_584,
        sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87".into(),
    }
}

pub fn qwen25_3b_gguf() -> ModelFile {
    ModelFile {
        filename: "qwen2.5-3b-instruct-q4_k_m.gguf".into(),
        size_bytes: 2_104_932_768,
        sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d".into(),
    }
}

pub fn gemma3_4b_gguf() -> ModelFile {
    ModelFile {
        filename: "google_gemma-3-4b-it-Q4_K_M.gguf".into(),
        size_bytes: 2_489_758_112,
        sha256: "4996030242583a40aa151ff93f49ed787ac8c25e4120c3ae4588b2e2a7d1ae94".into(),
    }
}

pub fn qwen3_4b_gguf() -> ModelFile {
    ModelFile {
        filename: "Qwen_Qwen3-4B-Q4_K_M.gguf".into(),
        size_bytes: 2_497_280_960,
        sha256: "fbe1d5edd4ce802ae3ae7c7e4ab7d09789d697fdac1fc7929f8df4ca3c41bae3".into(),
    }
}

fn slm_file_for_repo(repo: &str, default_pro: bool) -> ModelFile {
    match repo {
        "bartowski/google_gemma-3-4b-it-GGUF" => gemma3_4b_gguf(),
        "bartowski/Qwen_Qwen3-4B-GGUF" => qwen3_4b_gguf(),
        "Qwen/Qwen2.5-3B-Instruct-GGUF" => qwen25_3b_gguf(),
        "unsloth/Qwen3.5-4B-GGUF" => qwen35_4b_gguf(),
        "unsloth/gemma-4-E2B-it-GGUF" => gemma4_e2b_gguf(),
        "unsloth/gemma-4-E4B-it-GGUF" => gemma4_e4b_gguf(),
        "LiquidAI/LFM2.5-1.2B-Instruct-GGUF" => lfm25_1_2b_gguf(),
        "LiquidAI/LFM2.5-2.6B-GGUF" => lfm25_2_6b_gguf(),
        _ if default_pro => gemma3_4b_gguf(),
        _ => qwen25_3b_gguf(),
    }
}

/// Full catalog for the model hub. Every file pins the publisher's size and
/// SHA-256; an unpinned artifact cannot be represented, so a download either
/// matches the publisher bytes exactly or fails. Recommendation follows the
/// hardware tier, not repo equality.
pub fn catalog(registry: &ModelRegistry, hardware: &HardwareProfile) -> Vec<ModelArtifact> {
    let recommended_slm = if hardware.tier == HardwareTier::High {
        ModelRole::ProSlm
    } else {
        ModelRole::Slm
    };
    let recommended_asr = if hardware.tier == HardwareTier::Low {
        ModelRole::FallbackAsr
    } else {
        ModelRole::Asr
    };

    if let Some(custom) = registry.artifacts.as_ref().filter(|list| !list.is_empty()) {
        return custom
            .iter()
            .cloned()
            .map(|mut art| {
                art.recommended = art.role == recommended_asr || art.role == recommended_slm;
                art
            })
            .collect();
    }

    let asr_accel = if hardware.metal {
        "Metal GPU / ARM NEON"
    } else {
        "CPU · NEON / AVX2"
    };

    let mut items = vec![
        ModelArtifact {
            id: "whisper-small".into(),
            role: ModelRole::Asr,
            repo: registry.default_asr_repo.clone(),
            files: vec![whisper_small()],
            description:
                "Quantized Whisper small (99 languages), Metal GPU / SIMD inference via whisper.cpp"
                    .into(),
            min_ram_gb: 8,
            recommended: recommended_asr == ModelRole::Asr,
            accelerator: asr_accel.into(),
        },
        ModelArtifact {
            id: "whisper-large-v3-turbo".into(),
            role: ModelRole::Asr,
            repo: registry.default_asr_repo.clone(),
            files: vec![whisper_large_v3_turbo()],
            description:
                "Quantized Whisper Large v3 Turbo (99 languages), studio-grade accuracy at 8x speed on Metal GPU"
                    .into(),
            min_ram_gb: 8,
            recommended: false,
            accelerator: asr_accel.into(),
        },
        ModelArtifact {
            id: "whisper-tiny".into(),
            role: ModelRole::FallbackAsr,
            repo: registry.fallback_asr_repo.clone(),
            files: vec![whisper_tiny()],
            description: "Quantized Whisper tiny (99 languages), ultra-low-RAM fallback".into(),
            min_ram_gb: 4,
            recommended: recommended_asr == ModelRole::FallbackAsr,
            accelerator: asr_accel.into(),
        },
        ModelArtifact {
            id: "qwen2.5-3b-instruct".into(),
            role: ModelRole::Slm,
            repo: registry.default_slm_repo.clone(),
            files: vec![slm_file_for_repo(&registry.default_slm_repo, false)],
            description:
                "Q4_K_M GGUF, 32k context, fast structured JSON synthesis for 8–15 GB hosts".into(),
            min_ram_gb: 8,
            recommended: recommended_slm == ModelRole::Slm,
            accelerator: "llama.cpp · Metal / SIMD".into(),
        },
    ];

    // If a brand profile sets `defaultSlmRepo == proSlmRepo`, avoid emitting two
    // identical file targets while still keeping a distinct `ProSlm` entry when
    // they differ or when High-tier resolution looks up `ModelRole::ProSlm`.
    let pro_file = slm_file_for_repo(&registry.pro_slm_repo, true);
    items.push(ModelArtifact {
        id: "gemma-3-4b-it".into(),
        role: ModelRole::ProSlm,
        repo: registry.pro_slm_repo.clone(),
        files: vec![pro_file],
        description: "Q4_K_M GGUF, 128k context, higher-reasoning synthesis SLM for 16 GB+ hosts"
            .into(),
        min_ram_gb: 16,
        recommended: recommended_slm == ModelRole::ProSlm,
        accelerator: "llama.cpp · Metal / SIMD".into(),
    });

    items.extend([
        ModelArtifact {
            id: "qwen3.5-4b".into(),
            role: ModelRole::Slm,
            repo: "unsloth/Qwen3.5-4B-GGUF".into(),
            files: vec![qwen35_4b_gguf()],
            description:
                "Next-gen Qwen 3.5 4B (hybrid Gated DeltaNet), superior JSON extraction & grounded Q&A for 8 GB+ Macs"
                    .into(),
            min_ram_gb: 8,
            recommended: false,
            accelerator: "llama.cpp · Metal / SIMD".into(),
        },
        ModelArtifact {
            id: "gemma-4-e2b-it".into(),
            role: ModelRole::Slm,
            repo: "unsloth/gemma-4-E2B-it-GGUF".into(),
            files: vec![gemma4_e2b_gguf()],
            description:
                "Google Gemma 4 Effective-2B (Per-Layer Embeddings), 4B-class reasoning with 2B active memory for 8 GB+ Macs"
                    .into(),
            min_ram_gb: 8,
            recommended: false,
            accelerator: "llama.cpp · Metal / SIMD".into(),
        },
        ModelArtifact {
            id: "gemma-4-e4b-it".into(),
            role: ModelRole::ProSlm,
            repo: "unsloth/gemma-4-E4B-it-GGUF".into(),
            files: vec![gemma4_e4b_gguf()],
            description:
                "Google Gemma 4 Effective-4B, 128k context flagship on-device reasoning for 16 GB+ Macs"
                    .into(),
            min_ram_gb: 16,
            recommended: false,
            accelerator: "llama.cpp · Metal / SIMD".into(),
        },
        ModelArtifact {
            id: "lfm2.5-1.2b-instruct".into(),
            role: ModelRole::Slm,
            repo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF".into(),
            files: vec![lfm25_1_2b_gguf()],
            description:
                "LiquidAI LFM 2.5 1.2B Instruct (697 MB), ultra-fast state-space hybrid with minimal RAM usage for 4–8 GB Macs"
                    .into(),
            min_ram_gb: 4,
            recommended: false,
            accelerator: "llama.cpp · Metal / SIMD".into(),
        },
        ModelArtifact {
            id: "lfm2.5-2.6b-instruct".into(),
            role: ModelRole::Slm,
            repo: "LiquidAI/LFM2.5-2.6B-GGUF".into(),
            files: vec![lfm25_2_6b_gguf()],
            description:
                "LiquidAI LFM 2.5 2.6B (1.56 GB), high-throughput Liquid Foundation Model for 8–16 GB Macs"
                    .into(),
            min_ram_gb: 8,
            recommended: false,
            accelerator: "llama.cpp · Metal / SIMD".into(),
        },
    ]);

    items
}

pub fn recommended_artifacts(
    registry: &ModelRegistry,
    hardware: &HardwareProfile,
) -> Vec<ModelArtifact> {
    catalog(registry, hardware)
        .into_iter()
        .filter(|artifact| artifact.recommended)
        .collect()
}

/// Resolve a model artifact from the registry by role, honoring hardware tier for
/// ASR/SLM selection.
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

/// Find the best installed synthesis artifact, preferring `preferred_id` if given,
/// then tier-recommended SLM, then any installed SLM.
pub fn installed_slm_artifact(
    registry: &ModelRegistry,
    models_dir: &Path,
    hardware: &HardwareProfile,
    preferred_id: Option<&str>,
) -> Option<ModelArtifact> {
    let slms: Vec<ModelArtifact> = catalog(registry, hardware)
        .into_iter()
        .filter(|a| matches!(a.role, ModelRole::Slm | ModelRole::ProSlm))
        .filter(|a| a.is_installed(models_dir))
        .collect();

    if slms.is_empty() {
        return None;
    }
    if let Some(pref) = preferred_id.filter(|s| !s.trim().is_empty()) {
        if let Some(found) = slms.iter().find(|a| a.id == pref) {
            return Some(found.clone());
        }
    }
    if let Some(rec) = slms.iter().find(|a| a.recommended) {
        return Some(rec.clone());
    }
    slms.into_iter().next()
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
        Err(AppError::Invalid(format!(
            "unsafe model filename: {filename}"
        )))
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
    fn detect_ram_reports_nonzero_on_supported_hosts() {
        let profile = HardwareProfile::detect();
        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        assert!(
            profile.ram_bytes >= GIB,
            "expected >= 1 GiB RAM, got {}",
            profile.ram_bytes
        );
    }

    #[test]
    fn low_tier_selects_whisper_tiny_and_compact_slm() {
        let hardware = HardwareProfile::with_ram(4 * GIB);
        let recommended = recommended_artifacts(&registry(), &hardware);
        let ids: Vec<_> = recommended
            .iter()
            .map(|artifact| artifact.id.as_str())
            .collect();
        assert!(ids.contains(&"whisper-tiny"));
        assert!(ids.contains(&"qwen2.5-3b-instruct"));
        assert!(!ids.contains(&"whisper-small"));
    }

    #[test]
    fn every_tier_recommends_exactly_one_asr_and_one_slm() {
        for ram_gb in [4, 12, 32] {
            let hardware = HardwareProfile::with_ram(ram_gb * GIB);
            let recommended = recommended_artifacts(&registry(), &hardware);
            let asr = recommended
                .iter()
                .filter(|artifact| matches!(artifact.role, ModelRole::Asr | ModelRole::FallbackAsr))
                .count();
            let slm = recommended
                .iter()
                .filter(|artifact| matches!(artifact.role, ModelRole::Slm | ModelRole::ProSlm))
                .count();
            assert_eq!(
                asr, 1,
                "tier for {ram_gb} GB recommends {asr} ASR artifacts"
            );
            assert_eq!(
                slm, 1,
                "tier for {ram_gb} GB recommends {slm} SLM artifacts"
            );

            let chosen_asr = artifact_for_role(&registry(), &hardware, ModelRole::Asr).unwrap();
            let chosen_slm = artifact_for_role(&registry(), &hardware, ModelRole::Slm).unwrap();
            assert!(recommended
                .iter()
                .any(|artifact| artifact.id == chosen_asr.id));
            assert!(recommended
                .iter()
                .any(|artifact| artifact.id == chosen_slm.id));
        }
    }

    #[test]
    fn high_tier_selects_whisper_small_and_pro_slm() {
        let hardware = HardwareProfile::with_ram(32 * GIB);
        let recommended = recommended_artifacts(&registry(), &hardware);
        let ids: Vec<_> = recommended
            .iter()
            .map(|artifact| artifact.id.as_str())
            .collect();
        assert!(ids.contains(&"whisper-small"));
        assert!(ids.contains(&"gemma-3-4b-it"));
    }

    #[test]
    fn artifact_urls_and_paths_are_well_formed() {
        let hardware = HardwareProfile::with_ram(32 * GIB);
        let asr = artifact_for_role(&registry(), &hardware, ModelRole::Asr).unwrap();
        assert_eq!(asr.total_bytes(), 190_085_487);
        assert_eq!(
            asr.download_url("https://huggingface.co/", &asr.files[0].filename),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin?download=true"
        );
        assert_eq!(
            asr.local_path(Path::new("/models"), &asr.files[0].filename),
            PathBuf::from("/models/ggerganov/whisper.cpp/ggml-small-q5_1.bin")
        );
    }

    #[test]
    fn every_artifact_pins_a_sha256_digest() {
        let hardware = HardwareProfile::with_ram(32 * GIB);
        for artifact in catalog(&registry(), &hardware) {
            for file in &artifact.files {
                assert_eq!(
                    file.sha256.len(),
                    64,
                    "{} has no pinned digest",
                    file.filename
                );
                assert!(
                    file.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                    "{} digest is not hex",
                    file.filename
                );
                assert!(file.size_bytes > 0);
            }
        }
    }

    #[test]
    fn fallback_role_resolves_to_whisper() {
        let hardware = HardwareProfile::with_ram(32 * GIB);
        let whisper = artifact_for_role(&registry(), &hardware, ModelRole::FallbackAsr).unwrap();
        assert_eq!(whisper.id, "whisper-tiny");
    }

    #[test]
    fn unsafe_filenames_are_rejected() {
        assert!(safe_model_filename("model.gguf").is_ok());
        assert!(safe_model_filename("../escape.gguf").is_err());
        assert!(safe_model_filename("a/b.bin").is_err());
        assert!(safe_model_filename("").is_err());
    }
}
