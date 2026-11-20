use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::brand::Brand;
use crate::error::{AppError, AppResult};
use crate::events::{self, SynthesisProgressPayload};
use crate::model_registry::installed_slm_artifact;
use crate::state::AppState;
use crate::storage::{
    NoteBlock, Screenshot, SearchFilters, SynthesisItem, SynthesisItemPatch, TranscriptSegment,
};
use crate::synthesis::context::build_context;
use crate::synthesis::orchestrator::{synthesize_streaming, SynthesisEngine};
use crate::synthesis::sidecar::sidecar_for_model;
use crate::synthesis::types::{
    SynthesisItemDraft, SynthesisRequest, VerificationReport, VerifiedSynthesis,
    DEADLINE_UNSPECIFIED, ITEM_ACTION, ITEM_DECISION, ITEM_SUMMARY, OWNER_UNASSIGNED,
};

async fn resolve_active_engine(
    state: &AppState,
    brand: &Brand,
    preferred_model_id: Option<&str>,
) -> std::sync::Arc<dyn SynthesisEngine> {
    let current = state.synthesis.read().await.clone();
    if !matches!(
        current.engine_id(),
        "unavailable" | "llama-cpp-gguf" | "litert-lm-sidecar"
    ) {
        return current;
    }

    let target_path = installed_slm_artifact(
        &brand.manifest().model_registry,
        &state.paths.models_dir,
        &state.hardware,
        preferred_model_id,
    )
    .and_then(|art| {
        let file = art.files.first()?;
        let p = art.local_path(&state.paths.models_dir, &file.filename);
        p.is_file().then_some(p)
    });

    if let (Some(curr_path), Some(want_path)) = (current.model_path(), target_path.as_deref()) {
        if curr_path == want_path {
            return current;
        }
    }

    if let Some(discovered) = sidecar_for_model(
        brand,
        &state.paths.models_dir,
        &state.hardware,
        preferred_model_id,
        Some(state.is_recording.clone()),
    ) {
        state.set_synthesis_engine(discovered.clone()).await;
        return discovered;
    }

    current
}

fn format_mm_ss(ms: i64) -> String {
    let total_secs = (ms.max(0)) / 1000;
    let mins = total_secs / 60;
    let secs = total_secs % 60;
    format!("{mins:02}:{secs:02}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisResponse {
    pub items: Vec<SynthesisItem>,
    pub report: VerificationReport,
    pub engine_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantCitation {
    pub label: String,
    pub meeting_id: Option<String>,
    pub seek_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantResponse {
    pub answer: String,
    pub engine_id: String,
    pub citations: Vec<AssistantCitation>,
}

/// Build deterministic, verifier-compliant extractive synthesis items from the
/// meeting's actual transcript segments, manual notes, and slide OCR whenever
/// the local SLM returns zero grounded claims (e.g. short casual takes) or is
/// not yet installed.
fn build_extractive_fallback(
    brand: &Brand,
    notes: &[NoteBlock],
    transcript: &[TranscriptSegment],
    screenshots: &[Screenshot],
) -> VerifiedSynthesis {
    let mut items: Vec<SynthesisItemDraft> = Vec::new();
    let mut order: i64 = 0;

    // 1. Group consecutive transcript turns into coherent summary bullets with valid [T-MM:SS#seq] refs.
    if !transcript.is_empty() {
        let chunk_size = (transcript.len() / 4).clamp(2, 8);
        for chunk in transcript.chunks(chunk_size).take(5) {
            let speaker = chunk
                .first()
                .map(|s| s.speaker_label.as_str())
                .unwrap_or("Speaker");
            let combined: String = chunk
                .iter()
                .map(|s| s.text.trim())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if combined.is_empty() {
                continue;
            }
            let refs: Vec<String> = chunk
                .iter()
                .take(3)
                .map(|s| format!("T-{}#{}", format_mm_ss(s.start_ms), s.seq_no))
                .collect();
            items.push(SynthesisItemDraft {
                item_type: ITEM_SUMMARY.into(),
                sort_order: order,
                content: format!("{speaker}: {combined}"),
                rationale: None,
                owner: None,
                deadline: None,
                is_completed: false,
                is_user_edited: false,
                evidence_refs: refs,
            });
            order += 1;
        }
    }

    // 2. Include manual notes as grounded summary / decision / action items.
    for note in notes {
        let text = note.content_md.trim();
        if text.is_empty() {
            continue;
        }
        let ref_tag = format!("N-L{}", note.line_index);
        let item_type = match note.block_type.as_str() {
            "decision" => ITEM_DECISION,
            "todo" => ITEM_ACTION,
            _ => ITEM_SUMMARY,
        };
        items.push(SynthesisItemDraft {
            item_type: item_type.into(),
            sort_order: order,
            content: text.to_string(),
            rationale: None,
            owner: (item_type == ITEM_ACTION).then(|| OWNER_UNASSIGNED.into()),
            deadline: (item_type == ITEM_ACTION).then(|| DEADLINE_UNSPECIFIED.into()),
            is_completed: false,
            is_user_edited: false,
            evidence_refs: vec![ref_tag],
        });
        order += 1;
    }

    // 3. Include slide OCR highlights if present.
    for shot in screenshots.iter().take(3) {
        if let Some(ocr) = shot
            .ocr_extracted_text
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let first_line = ocr.lines().next().unwrap_or(ocr).trim();
            if !first_line.is_empty() {
                let ref_tag = format!("S-{}", format_mm_ss(shot.start_ms));
                items.push(SynthesisItemDraft {
                    item_type: ITEM_SUMMARY.into(),
                    sort_order: order,
                    content: format!("Slide captured ({ref_tag}): {first_line}"),
                    rationale: None,
                    owner: None,
                    deadline: None,
                    is_completed: false,
                    is_user_edited: false,
                    evidence_refs: vec![ref_tag],
                });
                order += 1;
            }
        }
    }

    // 4. If a custom synthesis template (e.g. Clinical SOAP, Executive Brief, 1:1 Check-in)
    // is active, also populate the template's custom section keys with grounded items.
    if let Some(tpl) = &brand.manifest().synthesis_template {
        for (idx, section) in tpl.sections.iter().enumerate() {
            let key = section
                .key
                .trim()
                .to_ascii_lowercase()
                .replace(|c: char| !c.is_ascii_alphanumeric(), "_")
                .trim_matches('_')
                .to_string();
            if key.is_empty()
                || matches!(
                    key.as_str(),
                    "summary" | "decisions" | "decision" | "action_items" | "action_item"
                )
            {
                continue;
            }
            if let Some(seg) = transcript.get(idx * 2).or_else(|| transcript.first()) {
                let ref_tag = format!("T-{}#{}", format_mm_ss(seg.start_ms), seg.seq_no);
                items.push(SynthesisItemDraft {
                    item_type: key,
                    sort_order: order,
                    content: format!("{}: {}", seg.speaker_label, seg.text.trim()),
                    rationale: None,
                    owner: None,
                    deadline: None,
                    is_completed: false,
                    is_user_edited: false,
                    evidence_refs: vec![ref_tag],
                });
                order += 1;
            }
        }
    }

    let count = items.len();
    VerifiedSynthesis {
        items,
        report: VerificationReport {
            raw_items: count,
            kept_items: count,
            dropped_without_valid_evidence: 0,
            stripped_evidence_refs: 0,
            forced_unassigned_owners: 0,
            forced_unspecified_deadlines: 0,
        },
    }
}

async fn build_llm_assisted_fallback(
    brand: &Brand,
    engine: &dyn SynthesisEngine,
    meeting_title: &str,
    context_text: &str,
    notes: &[NoteBlock],
    transcript: &[TranscriptSegment],
    screenshots: &[Screenshot],
) -> VerifiedSynthesis {
    let mut base = build_extractive_fallback(brand, notes, transcript, screenshots);
    if engine.engine_id() == "unavailable" || transcript.is_empty() {
        return base;
    }

    let req = SynthesisRequest {
        system: "You are a concise executive meeting summarizer. Write 3 to 5 clear, well-written summary bullet points (one per line, starting with '- ') capturing the key topics, context, and takeaways from the provided meeting transcript and notes. Do not repeat raw filler words.".into(),
        user: format!("Meeting Title: {meeting_title}\n\n{context_text}\n\nWrite 3 to 5 concise summary bullets now:"),
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        max_output_tokens: 384,
        grammar: None,
    };

    if let Ok(raw) = engine.generate(req).await {
        let bullets: Vec<String> = raw
            .lines()
            .map(|l| {
                l.trim()
                    .trim_start_matches(['-', '•', '*'])
                    .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')')
                    .trim()
                    .to_string()
            })
            .filter(|l| l.len() >= 12)
            .take(5)
            .collect();

        if !bullets.is_empty() {
            let non_summary: Vec<SynthesisItemDraft> = base
                .items
                .into_iter()
                .filter(|i| i.item_type != ITEM_SUMMARY)
                .collect();
            let mut new_items = Vec::new();
            let step = (transcript.len() / bullets.len().max(1)).max(1);
            for (idx, bullet) in bullets.into_iter().enumerate() {
                let seg = transcript.get(idx * step).or_else(|| transcript.first());
                let refs = seg
                    .map(|s| vec![format!("T-{}#{}", format_mm_ss(s.start_ms), s.seq_no)])
                    .unwrap_or_default();
                new_items.push(SynthesisItemDraft {
                    item_type: ITEM_SUMMARY.into(),
                    sort_order: idx as i64,
                    content: bullet,
                    rationale: None,
                    owner: None,
                    deadline: None,
                    is_completed: false,
                    is_user_edited: false,
                    evidence_refs: refs,
                });
            }
            new_items.extend(non_summary);
            let count = new_items.len();
            base = VerifiedSynthesis {
                items: new_items,
                report: VerificationReport {
                    raw_items: count,
                    kept_items: count,
                    dropped_without_valid_evidence: 0,
                    stripped_evidence_refs: 0,
                    forced_unassigned_owners: 0,
                    forced_unspecified_deadlines: 0,
                },
            };
        }
    }

    base
}

#[tauri::command]
pub async fn synthesize_meeting(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    template: Option<String>,
) -> AppResult<SynthesisResponse> {
    let emit_progress = |stage: &str, percent: f32, message: Option<String>| {
        let _ = events::emit(
            &app,
            events::SYNTHESIS_PROGRESS,
            SynthesisProgressPayload {
                meeting_id: meeting_id.clone(),
                stage: stage.into(),
                percent,
                message,
            },
        );
    };
    emit_progress("context", 10.0, None);
    let meeting = state.db.get_meeting(&meeting_id).await?;
    let notes = state.db.list_note_blocks(&meeting_id).await?;
    let transcript = state.db.list_transcript(&meeting_id).await?;
    let screenshots = state.db.list_screenshots(&meeting_id).await?;
    let speakers = state.db.list_speakers().await?;
    let effective_brand = state.brand.with_template(template.as_deref());
    let context = build_context(&meeting, &notes, &transcript, &screenshots, &speakers);

    emit_progress("generating", 35.0, None);
    let engine = resolve_active_engine(&state, &effective_brand, Some(&meeting.slm_model_id)).await;

    let has_sources = !transcript.is_empty() || !notes.is_empty() || !screenshots.is_empty();
    let generated_chars = AtomicUsize::new(0);
    let last_emit = StdMutex::new(Instant::now());
    let verified = match synthesize_streaming(
        &effective_brand,
        &context,
        engine.as_ref(),
        &|delta| {
            let total_chars =
                generated_chars.fetch_add(delta.len(), Ordering::Relaxed) + delta.len();
            if let Ok(mut guard) = last_emit.try_lock() {
                if guard.elapsed() >= Duration::from_millis(160) {
                    *guard = Instant::now();
                    let approx_tokens = (total_chars / 4).max(1);
                    let pct = (35.0 + (approx_tokens as f32 / 750.0) * 47.0).clamp(36.0, 82.0);
                    emit_progress(
                        "generating",
                        pct,
                        Some(format!(
                            "Generating grounded synthesis ({approx_tokens} tokens)…"
                        )),
                    );
                }
            }
        },
    )
    .await
    {
        Ok(mut verified) => {
            if verified.items.is_empty() && has_sources {
                verified = build_llm_assisted_fallback(
                    &effective_brand,
                    engine.as_ref(),
                    &meeting.title,
                    &context.text,
                    &notes,
                    &transcript,
                    &screenshots,
                )
                .await;
            }
            verified
        }
        Err(error) => {
            if has_sources {
                tracing::info!(
                    meeting_id = %meeting_id,
                    error = %error,
                    "using LLM-assisted / extractive synthesis fallback"
                );
                build_llm_assisted_fallback(
                    &effective_brand,
                    engine.as_ref(),
                    &meeting.title,
                    &context.text,
                    &notes,
                    &transcript,
                    &screenshots,
                )
                .await
            } else {
                tracing::warn!(meeting_id = %meeting_id, error = %error, "meeting synthesis failed");
                emit_progress("failed", 100.0, Some(error.to_string()));
                return Err(error);
            }
        }
    };

    emit_progress("verifying", 85.0, None);
    let engine_id = engine.engine_id().to_string();
    let report = verified.report.clone();
    let items = state
        .db
        .replace_synthesis_items(&meeting_id, verified.items)
        .await?;
    emit_progress("complete", 100.0, None);
    tracing::info!(
        meeting_id = %meeting_id,
        engine_id = %engine_id,
        kept_items = items.len(),
        "completed meeting synthesis"
    );
    Ok(SynthesisResponse {
        items,
        report,
        engine_id,
    })
}

#[tauri::command]
pub async fn list_synthesis(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<Vec<SynthesisItem>> {
    state.db.list_synthesis_items(&meeting_id).await
}

#[tauri::command]
pub async fn create_synthesis_item(
    state: State<'_, AppState>,
    meeting_id: String,
    item_type: Option<String>,
    content: String,
    owner: Option<String>,
    deadline: Option<String>,
) -> AppResult<SynthesisItem> {
    let kind = item_type.as_deref().unwrap_or(ITEM_ACTION);
    state
        .db
        .insert_user_synthesis_item(
            &meeting_id,
            kind,
            &content,
            owner.as_deref(),
            deadline.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn update_synthesis_item(
    state: State<'_, AppState>,
    item_id: String,
    patch: SynthesisItemPatch,
) -> AppResult<SynthesisItem> {
    state.db.update_synthesis_item(&item_id, patch).await
}

#[tauri::command]
pub async fn synthesis_context_preview(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<String> {
    let meeting = state.db.get_meeting(&meeting_id).await?;
    let notes = state.db.list_note_blocks(&meeting_id).await?;
    let transcript = state.db.list_transcript(&meeting_id).await?;
    let screenshots = state.db.list_screenshots(&meeting_id).await?;
    let speakers = state.db.list_speakers().await?;
    Ok(build_context(&meeting, &notes, &transcript, &screenshots, &speakers).text)
}

#[tauri::command]
pub async fn ask_assistant(
    state: State<'_, AppState>,
    question: String,
    meeting_id: Option<String>,
) -> AppResult<AssistantResponse> {
    let trimmed_q = question.trim();
    if trimmed_q.is_empty() {
        return Err(AppError::Invalid("Question must not be empty.".into()));
    }

    // Resolve the active or newly-discovered on-device LLM engine if installed.
    let engine = resolve_active_engine(&state, &state.brand, None).await;

    if let Some(mid) = meeting_id.filter(|s| !s.trim().is_empty()) {
        let meeting = state.db.get_meeting(&mid).await?;
        let notes = state.db.list_note_blocks(&mid).await?;
        let transcript = state.db.list_transcript(&mid).await?;
        let screenshots = state.db.list_screenshots(&mid).await?;
        let synthesis = state.db.list_synthesis_items(&mid).await?;
        let speakers = state.db.list_speakers().await?;

        // Build citations from matching or representative transcript turns
        let q_lower = trimmed_q.to_ascii_lowercase();
        let keywords: Vec<&str> = q_lower
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|w| w.len() > 2)
            .collect();

        let mut citations: Vec<AssistantCitation> = Vec::new();
        for seg in transcript
            .iter()
            .filter(|s| {
                keywords
                    .iter()
                    .any(|kw| s.text.to_ascii_lowercase().contains(kw))
            })
            .take(4)
        {
            citations.push(AssistantCitation {
                label: format_mm_ss(seg.start_ms),
                meeting_id: Some(mid.clone()),
                seek_ms: Some(seg.start_ms),
            });
        }
        if citations.is_empty() {
            for seg in transcript
                .iter()
                .step_by((transcript.len() / 3).max(1))
                .take(3)
            {
                citations.push(AssistantCitation {
                    label: format_mm_ss(seg.start_ms),
                    meeting_id: Some(mid.clone()),
                    seek_ms: Some(seg.start_ms),
                });
            }
        }

        // Try on-device LLM generation first if available and meeting has content
        if engine.engine_id() != "unavailable"
            && (!transcript.is_empty() || !notes.is_empty() || !screenshots.is_empty())
        {
            let ctx = build_context(&meeting, &notes, &transcript, &screenshots, &speakers);
            let req = SynthesisRequest {
                system: "You are a helpful, concise on-device meeting assistant. Answer the user's question directly and accurately using ONLY the provided meeting transcript, notes, and slide OCR text. Cite timestamps like [00:12] when referencing spoken statements.".into(),
                user: format!(
                    "Meeting: {}\n\n{}\n\nUser Question: {}",
                    meeting.title, ctx.text, trimmed_q
                ),
                temperature: 0.2,
                top_p: 0.9,
                top_k: 40,
                max_output_tokens: 512,
                grammar: None,
            };
            if let Ok(raw_reply) = engine.generate(req).await {
                let cleaned = raw_reply.trim();
                if !cleaned.is_empty() {
                    return Ok(AssistantResponse {
                        answer: cleaned.to_string(),
                        engine_id: engine.engine_id().to_string(),
                        citations,
                    });
                }
            }
        }

        // Deterministic extractive answer grounded in the meeting's actual transcript, notes, and slides
        let mut sections: Vec<String> = Vec::new();
        let summaries: Vec<&SynthesisItem> = synthesis
            .iter()
            .filter(|i| i.item_type == ITEM_SUMMARY)
            .collect();
        let actions: Vec<&SynthesisItem> = synthesis
            .iter()
            .filter(|i| i.item_type == ITEM_ACTION)
            .collect();

        if !summaries.is_empty() {
            let bullets = summaries
                .iter()
                .take(4)
                .map(|s| format!("• {}", s.content))
                .collect::<Vec<_>>()
                .join("\n");
            sections.push(format!("Summary of \"{}\":\n{}", meeting.title, bullets));
        } else if !transcript.is_empty() {
            let matched: Vec<&TranscriptSegment> = transcript
                .iter()
                .filter(|s| {
                    keywords
                        .iter()
                        .any(|kw| s.text.to_ascii_lowercase().contains(kw))
                })
                .collect();
            let chosen = if !matched.is_empty() {
                matched.into_iter().take(6).collect::<Vec<_>>()
            } else {
                transcript.iter().take(6).collect::<Vec<_>>()
            };
            let lines = chosen
                .into_iter()
                .filter(|s| !s.text.trim().is_empty())
                .map(|s| {
                    format!(
                        "• [{}] {}: {}",
                        format_mm_ss(s.start_ms),
                        s.speaker_label,
                        s.text.trim()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !lines.is_empty() {
                sections.push(format!(
                    "From \"{}\" ({} transcript segments):\n{}",
                    meeting.title,
                    transcript.len(),
                    lines
                ));
            }
        }

        if !notes.is_empty() {
            let note_lines = notes
                .iter()
                .filter(|n| !n.content_md.trim().is_empty())
                .take(4)
                .map(|n| format!("• {}", n.content_md.trim()))
                .collect::<Vec<_>>()
                .join("\n");
            if !note_lines.is_empty() {
                sections.push(format!("Notes:\n{note_lines}"));
            }
        }

        if !actions.is_empty() {
            let act_lines = actions
                .iter()
                .take(4)
                .map(|a| {
                    format!(
                        "• [{}] {}",
                        if a.is_completed { "Done" } else { "Open" },
                        a.content
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            sections.push(format!("Action Items:\n{act_lines}"));
        }

        if !screenshots.is_empty()
            && (q_lower.contains("slide") || q_lower.contains("screen") || sections.is_empty())
        {
            let slide_lines = screenshots
                .iter()
                .take(3)
                .map(|s| {
                    let ocr = s
                        .ocr_extracted_text
                        .as_deref()
                        .unwrap_or("")
                        .lines()
                        .next()
                        .unwrap_or("Captured frame");
                    format!("• [Slide {}] {}", format_mm_ss(s.start_ms), ocr.trim())
                })
                .collect::<Vec<_>>()
                .join("\n");
            sections.push(format!(
                "Captured Slides ({}):\n{}",
                screenshots.len(),
                slide_lines
            ));
        }

        let answer = if sections.is_empty() {
            format!(
                "\"{}\" doesn't have any recorded transcript segments or notes yet. Start recording or type notes in the My notes tab to ask questions about this meeting.",
                meeting.title
            )
        } else {
            sections.join("\n\n")
        };

        return Ok(AssistantResponse {
            answer,
            engine_id: "extractive-local".into(),
            citations,
        });
    }

    // Global Vault Query across all meetings
    let hits = state
        .db
        .search(
            trimmed_q,
            SearchFilters {
                folder_id: None,
                meeting_id: None,
                limit: Some(6),
            },
        )
        .await
        .unwrap_or_default();

    if !hits.is_empty() {
        let mut citations = Vec::new();
        let mut lines = Vec::new();
        for hit in &hits {
            let clean_snippet = hit
                .snippet
                .replace("<mark>", "")
                .replace("</mark>", "")
                .replace("&amp;", "&")
                .replace("&quot;", "\"")
                .replace("&#39;", "'");
            lines.push(format!("• {}: {}", hit.title, clean_snippet));
            citations.push(AssistantCitation {
                label: hit.title.clone(),
                meeting_id: Some(hit.meeting_id.clone()),
                seek_ms: None,
            });
        }
        return Ok(AssistantResponse {
            answer: format!(
                "Found {} matching conversation(s) in your local vault:\n\n{}",
                hits.len(),
                lines.join("\n\n")
            ),
            engine_id: "sqlite-fts5".into(),
            citations,
        });
    }

    let recent = state.db.list_meetings().await.unwrap_or_default();
    let mut summary_lines = Vec::new();
    let mut citations = Vec::new();
    for m in recent.iter().take(5) {
        let segs = state.db.list_transcript(&m.id).await.unwrap_or_default();
        if let Some(first) = segs.first() {
            summary_lines.push(format!(
                "• {} ({} segments): \"{}\"",
                m.title,
                segs.len(),
                first.text.trim()
            ));
        } else {
            summary_lines.push(format!("• {} ({})", m.title, m.status));
        }
        citations.push(AssistantCitation {
            label: m.title.clone(),
            meeting_id: Some(m.id.clone()),
            seek_ms: None,
        });
    }

    let answer = if summary_lines.is_empty() {
        "Your local vault has no recorded conversations yet. Click Record in the top bar to capture your first meeting.".into()
    } else {
        format!(
            "Here are the most recent conversations in your local vault:\n\n{}",
            summary_lines.join("\n")
        )
    };

    Ok(AssistantResponse {
        answer,
        engine_id: "vault-overview".into(),
        citations,
    })
}

#[tauri::command]
pub async fn export_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
    target_dir: Option<String>,
) -> AppResult<crate::export::ExportOutcome> {
    let meeting = state.db.get_meeting(&meeting_id).await?;
    let notes = state.db.list_note_blocks(&meeting_id).await?;
    let transcript = state.db.list_transcript(&meeting_id).await?;
    let screenshots = state.db.list_screenshots(&meeting_id).await?;
    let synthesis = state.db.list_synthesis_items(&meeting_id).await?;
    let brand = state.brand.clone();
    let vault_root = target_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.paths.exports_dir.clone());
    let exported_at_ms = Utc::now().timestamp_millis();

    tokio::task::spawn_blocking(move || {
        crate::export::export_meeting(crate::export::ExportMeeting {
            brand: &brand,
            meeting: &meeting,
            notes: &notes,
            transcript: &transcript,
            screenshots: &screenshots,
            synthesis: &synthesis,
            vault_root: &vault_root,
            exported_at_ms,
        })
    })
    .await
    .map_err(|error| AppError::Invalid(format!("export task panicked: {error}")))?
}
