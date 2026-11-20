//! whisper.cpp backend with Metal GPU acceleration (macOS/iOS) and pooled
//! decoder state so consecutive 30-second blocks reuse scratch allocations.

use std::path::Path;
use std::sync::Mutex;

use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use crate::asr::engine::{AsrEngine, AsrOptions, AsrSegment};
use crate::error::{AppError, AppResult};

pub struct WhisperEngine {
    context: WhisperContext,
    state_pool: Mutex<Option<WhisperState>>,
    model_id: String,
    threads: i32,
    gpu_enabled: bool,
}

impl WhisperEngine {
    pub fn load(model_path: &Path, model_id: impl Into<String>) -> AppResult<Self> {
        if !model_path.is_file() {
            return Err(AppError::Asr(format!(
                "ASR model is missing: {}",
                model_path.display()
            )));
        }
        whisper_rs::install_logging_hooks();

        let want_gpu = cfg!(any(target_os = "macos", target_os = "ios"))
            && std::env::var("MEMO_ASR_DISABLE_GPU").as_deref() != Ok("1");

        let (context, gpu_enabled) = if want_gpu {
            let mut gpu_params = WhisperContextParameters::default();
            gpu_params.use_gpu(true);
            match WhisperContext::new_with_params(model_path, gpu_params) {
                Ok(ctx) => (ctx, true),
                Err(gpu_error) => {
                    tracing::warn!(
                        error = %gpu_error,
                        "Whisper Metal GPU init failed; falling back to CPU inference"
                    );
                    let mut cpu_params = WhisperContextParameters::default();
                    cpu_params.use_gpu(false);
                    let ctx = WhisperContext::new_with_params(model_path, cpu_params).map_err(
                        |error| AppError::Asr(format!("cannot load the whisper model: {error}")),
                    )?;
                    (ctx, false)
                }
            }
        } else {
            let mut cpu_params = WhisperContextParameters::default();
            cpu_params.use_gpu(false);
            let ctx = WhisperContext::new_with_params(model_path, cpu_params).map_err(|error| {
                AppError::Asr(format!("cannot load the whisper model: {error}"))
            })?;
            (ctx, false)
        };

        let available = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(4);
        let threads = available.saturating_sub(1).clamp(1, 8) as i32;
        let model_id = model_id.into();

        let initial_state = context.create_state().ok();
        tracing::info!(
            model_id = %model_id,
            gpu_enabled,
            threads,
            "loaded on-device Whisper ASR engine"
        );

        Ok(Self {
            context,
            state_pool: Mutex::new(initial_state),
            model_id,
            threads,
            gpu_enabled,
        })
    }

    pub fn gpu_enabled(&self) -> bool {
        self.gpu_enabled
    }

    fn checkout_state(&self) -> AppResult<WhisperState> {
        if let Ok(mut guard) = self.state_pool.lock() {
            if let Some(state) = guard.take() {
                return Ok(state);
            }
        }
        self.context
            .create_state()
            .map_err(|error| AppError::Asr(format!("cannot create whisper state: {error}")))
    }

    fn return_state(&self, state: WhisperState) {
        if let Ok(mut guard) = self.state_pool.lock() {
            if guard.is_none() {
                *guard = Some(state);
            }
        }
    }
}

impl AsrEngine for WhisperEngine {
    fn engine_id(&self) -> &str {
        if self.gpu_enabled {
            "whisper-rs-metal"
        } else {
            "whisper-rs"
        }
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn transcribe(
        &self,
        samples_16k: &[f32],
        language: Option<&str>,
    ) -> AppResult<Vec<AsrSegment>> {
        self.transcribe_with_options(
            samples_16k,
            AsrOptions {
                language,
                initial_prompt: None,
            },
        )
    }

    fn transcribe_with_options(
        &self,
        samples_16k: &[f32],
        options: AsrOptions<'_>,
    ) -> AppResult<Vec<AsrSegment>> {
        if samples_16k.len() < 400 {
            return Ok(Vec::new());
        }
        let mut state = self.checkout_state()?;

        let sanitized_lang = options
            .language
            .map(|lang| lang.replace('\0', ""))
            .filter(|lang| !lang.trim().is_empty());
        let sanitized_prompt = options
            .initial_prompt
            .map(|prompt| prompt.replace('\0', " "))
            .filter(|prompt| !prompt.trim().is_empty());

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
        params.set_n_threads(self.threads);
        params.set_translate(false);
        params.set_no_context(sanitized_prompt.is_none());
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_language(sanitized_lang.as_deref());
        if let Some(prompt) = sanitized_prompt.as_deref() {
            params.set_initial_prompt(prompt);
        }

        state
            .full(params, samples_16k)
            .map_err(|error| AppError::Asr(format!("whisper inference failed: {error}")))?;

        let count = state.full_n_segments();
        let mut segments = Vec::with_capacity(count.max(0) as usize);
        for index in 0..count {
            let Some(segment) = state.get_segment(index) else {
                continue;
            };
            let text = segment
                .to_str_lossy()
                .map_err(|error| AppError::Asr(format!("cannot read a segment: {error}")))?;
            let start_ms = segment.start_timestamp() * 10;
            let end_ms = (segment.end_timestamp() * 10).max(start_ms);
            segments.push(AsrSegment {
                start_ms,
                end_ms,
                text: text.into_owned(),
            });
        }

        self.return_state(state);
        Ok(segments)
    }
}
