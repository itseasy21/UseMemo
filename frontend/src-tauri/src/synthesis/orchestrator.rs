use std::collections::BTreeSet;

use async_trait::async_trait;

use crate::brand::Brand;
use crate::error::AppResult;

use super::context::SynthesisContext;
use super::parse::parse_synthesis;
use super::prompt::build_request_for_text;
use super::types::{SynthesisRequest, VerificationReport, VerifiedSynthesis};
use super::verifier::verify_with_brand;

/// Maximum context bytes (~11k tokens) sent in a single inference window before
/// automatic map-reduce windowing kicks in for multi-hour transcripts.
pub const MAX_WINDOW_CHARS: usize = 44_000;

pub type TokenCallback<'a> = &'a (dyn Fn(&str) + Send + Sync);

#[async_trait]
pub trait SynthesisEngine: Send + Sync {
    fn engine_id(&self) -> &str;
    fn model_path(&self) -> Option<&std::path::Path> {
        None
    }
    async fn warm(&self) -> AppResult<()> {
        Ok(())
    }
    async fn unload(&self) -> AppResult<()> {
        Ok(())
    }
    async fn generate(&self, request: SynthesisRequest) -> AppResult<String>;

    async fn generate_streaming(
        &self,
        request: SynthesisRequest,
        _on_token: TokenCallback<'_>,
    ) -> AppResult<String> {
        self.generate(request).await
    }
}

/// Full pipeline: deterministic prompt -> local engine -> strict JSON parse ->
/// deterministic anti-hallucination verification.
pub async fn synthesize(
    brand: &Brand,
    context: &SynthesisContext,
    engine: &dyn SynthesisEngine,
) -> AppResult<VerifiedSynthesis> {
    synthesize_streaming(brand, context, engine, &|_| {}).await
}

pub async fn synthesize_streaming(
    brand: &Brand,
    context: &SynthesisContext,
    engine: &dyn SynthesisEngine,
    on_token: TokenCallback<'_>,
) -> AppResult<VerifiedSynthesis> {
    let windows = context.windowed_texts(MAX_WINDOW_CHARS);
    if windows.len() <= 1 {
        let request = build_request_for_text(brand, &context.text);
        let raw = engine.generate_streaming(request, on_token).await?;
        let parsed = parse_synthesis(&raw)?;
        return Ok(verify_with_brand(Some(brand), parsed, &context.index));
    }

    let mut combined_items = Vec::new();
    let mut combined_report = VerificationReport::default();
    let mut seen_keys: BTreeSet<(String, String)> = BTreeSet::new();

    for window_text in &windows {
        let request = build_request_for_text(brand, window_text);
        let raw = engine.generate_streaming(request, on_token).await?;
        let parsed = parse_synthesis(&raw)?;
        let chunk_verified = verify_with_brand(Some(brand), parsed, &context.index);
        combined_report.merge(&chunk_verified.report);

        for mut item in chunk_verified.items {
            let dedup_key = (item.item_type.clone(), item.content.trim().to_lowercase());
            if seen_keys.insert(dedup_key) {
                item.sort_order = combined_items
                    .iter()
                    .filter(|existing: &&super::types::SynthesisItemDraft| {
                        existing.item_type == item.item_type
                    })
                    .count() as i64;
                combined_items.push(item);
            }
        }
    }

    combined_report.kept_items = combined_items.len();
    Ok(VerifiedSynthesis {
        items: combined_items,
        report: combined_report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Meeting, NoteBlock, TranscriptSegment};

    struct StaticEngine(String);

    #[async_trait]
    impl SynthesisEngine for StaticEngine {
        fn engine_id(&self) -> &str {
            "static"
        }

        async fn generate(&self, _request: SynthesisRequest) -> AppResult<String> {
            Ok(self.0.clone())
        }
    }

    fn context() -> SynthesisContext {
        let meeting = Meeting {
            id: "m".into(),
            title: "Q3".into(),
            status: "completed".into(),
            created_at: 0,
            updated_at: 0,
            duration_ms: 600_000,
            audio_file_path: None,
            system_audio_file_path: None,
            system_audio_started_at_ms: 0,
            diarization_enabled: false,
            screenshot_interval_sec: 10,
            asr_model_id: "a".into(),
            slm_model_id: "s".into(),
            manual_notes_raw_md: String::new(),
            folder_id: None,
            is_starred: false,
        };
        let notes = vec![NoteBlock {
            id: "n".into(),
            meeting_id: "m".into(),
            line_index: 1,
            block_type: "paragraph".into(),
            content_md: "Launch moved to October 15.".into(),
            recording_offset_ms: Some(45_000),
            linked_screenshot_id: None,
        }];
        let transcript = vec![TranscriptSegment {
            id: "t".into(),
            meeting_id: "m".into(),
            seq_no: 1,
            start_ms: 40_000,
            end_ms: 52_000,
            speaker_id: None,
            speaker_label: "Sarah".into(),
            audio_channel: "system".into(),
            text: "We need to push the Q3 launch date to October 15th.".into(),
            is_confirmed: true,
        }];
        crate::synthesis::context::build_context(&meeting, &notes, &transcript, &[], &[])
    }

    #[tokio::test]
    async fn pipeline_verifies_model_output_end_to_end() {
        let engine = StaticEngine(
            r#"{"summary":[{"content":"Launch moved to October 15th.","evidenceIds":["T-00:40"]}],"decisions":[],"actionItems":[{"content":"Book the room","owner":"Bob","deadline":"Next Friday","evidenceIds":["T-00:40"]}]}"#.into(),
        );
        let brand = Brand::embedded().unwrap();
        let verified = synthesize(&brand, &context(), &engine).await.unwrap();
        assert_eq!(verified.summary().len(), 1);
        assert_eq!(
            verified.action_items()[0].owner.as_deref(),
            Some("Unassigned")
        );
        assert_eq!(
            verified.action_items()[0].deadline.as_deref(),
            Some("Not specified")
        );
    }

    #[tokio::test]
    async fn unparseable_model_output_is_an_error_not_an_empty_success() {
        let engine = StaticEngine("nothing useful".into());
        let brand = Brand::embedded().unwrap();
        assert!(synthesize(&brand, &context(), &engine).await.is_err());
    }
}
