use async_trait::async_trait;

use crate::brand::Brand;
use crate::error::AppResult;

use super::context::SynthesisContext;
use super::parse::parse_synthesis;
use super::prompt::build_request;
use super::types::{SynthesisRequest, VerifiedSynthesis};
use super::verifier::verify;

#[async_trait]
pub trait SynthesisEngine: Send + Sync {
    fn engine_id(&self) -> &str;
    async fn generate(&self, request: SynthesisRequest) -> AppResult<String>;
}

/// Full pipeline: deterministic prompt -> local engine -> strict JSON parse ->
/// deterministic anti-hallucination verification.
pub async fn synthesize(
    brand: &Brand,
    context: &SynthesisContext,
    engine: &dyn SynthesisEngine,
) -> AppResult<VerifiedSynthesis> {
    let request = build_request(brand, context);
    let raw = engine.generate(request).await?;
    let parsed = parse_synthesis(&raw)?;
    Ok(verify(parsed, &context.index))
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
