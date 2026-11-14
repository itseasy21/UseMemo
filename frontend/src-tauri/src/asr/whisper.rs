//! whisper.cpp backend.
//!
//! whisper.cpp is the one on-device ASR core with first-class support for macOS,
//! Windows, iOS and Android, so the same models and the same decode settings
//! travel with the product. Inference is CPU-only here on purpose: GPU paths
//! differ per platform and would need per-target validation before shipping.

use std::path::Path;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::asr::engine::{AsrEngine, AsrSegment};
use crate::error::{AppError, AppResult};

pub struct WhisperEngine {
    context: WhisperContext,
    model_id: String,
    threads: i32,
}

impl WhisperEngine {
    pub fn load(model_path: &Path, model_id: impl Into<String>) -> AppResult<Self> {
        if !model_path.is_file() {
            return Err(AppError::Asr(format!(
                "ASR model is missing: {}",
                model_path.display()
            )));
        }
        // whisper.cpp logs every token at info level. Route all of it through
        // the hook so a production build stays quiet unless a log backend is
        // compiled in.
        whisper_rs::install_logging_hooks();

        let mut parameters = WhisperContextParameters::default();
        parameters.use_gpu(false);
        let context = WhisperContext::new_with_params(model_path, parameters)
            .map_err(|error| AppError::Asr(format!("cannot load the whisper model: {error}")))?;

        let available = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(4);
        // Leave a core for the UI and audio capture.
        let threads = available.saturating_sub(1).clamp(1, 8) as i32;

        Ok(Self {
            context,
            model_id: model_id.into(),
            threads,
        })
    }
}

impl AsrEngine for WhisperEngine {
    fn engine_id(&self) -> &str {
        "whisper-rs"
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn transcribe(
        &self,
        samples_16k: &[f32],
        language: Option<&str>,
    ) -> AppResult<Vec<AsrSegment>> {
        if samples_16k.len() < 400 {
            // Under 25 ms: nothing a speech model can resolve.
            return Ok(Vec::new());
        }
        let mut state = self
            .context
            .create_state()
            .map_err(|error| AppError::Asr(format!("cannot create whisper state: {error}")))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
        params.set_n_threads(self.threads);
        params.set_translate(false);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_language(language);

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
            // whisper reports centiseconds.
            let start_ms = segment.start_timestamp() * 10;
            let end_ms = (segment.end_timestamp() * 10).max(start_ms);
            segments.push(AsrSegment {
                start_ms,
                end_ms,
                text: text.into_owned(),
            });
        }
        Ok(segments)
    }
}
