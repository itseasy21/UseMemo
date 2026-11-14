use crate::storage::{Meeting, NoteBlock, Screenshot, Speaker, TranscriptSegment};

use super::evidence::{format_timestamp, note_evidence_id, timestamp_evidence_id, EvidenceIndex};

#[derive(Debug, Clone)]
pub struct SynthesisContext {
    pub text: String,
    pub index: EvidenceIndex,
}

/// Assemble the strictly indexed context document. Every bullet emitted by the
/// model must be traceable to one of the IDs written here.
pub fn build_context(
    meeting: &Meeting,
    notes: &[NoteBlock],
    transcript: &[TranscriptSegment],
    screenshots: &[Screenshot],
    speakers: &[Speaker],
) -> SynthesisContext {
    let index = EvidenceIndex::from_records(notes, transcript, screenshots, speakers);
    let mut out = String::new();

    out.push_str("=== MEETING ===\n");
    out.push_str(&format!("Title: {}\n", sanitize(&meeting.title)));
    out.push_str(&format!("Status: {}\n", meeting.status));
    out.push_str(&format!(
        "Duration: {}s\n\n",
        meeting.duration_ms.max(0) / 1000
    ));

    out.push_str("=== USER MANUAL NOTES (HIGHEST PRIORITY) ===\n");
    if notes.is_empty() {
        out.push_str("(none)\n");
    } else {
        let mut ordered = notes.to_vec();
        ordered.sort_by_key(|note| note.line_index);
        for note in &ordered {
            let id = note_evidence_id(note.line_index);
            match note.recording_offset_ms {
                Some(offset) => out.push_str(&format!(
                    "[{} @ {}] {}\n",
                    id,
                    format_timestamp(offset),
                    sanitize(&note.content_md)
                )),
                None => out.push_str(&format!("[{}] {}\n", id, sanitize(&note.content_md))),
            }
        }
    }
    out.push('\n');

    let visual: Vec<&Screenshot> = screenshots
        .iter()
        .filter(|shot| {
            shot.ocr_extracted_text
                .as_deref()
                .map(str::trim)
                .is_some_and(|text| !text.is_empty())
        })
        .collect();
    if !visual.is_empty() {
        out.push_str("=== VISUAL SLIDE CAPTURES ===\n");
        for shot in visual {
            let id = timestamp_evidence_id("S", shot.start_ms);
            out.push_str(&format!(
                "[{}] {}\n",
                id,
                sanitize(shot.ocr_extracted_text.as_deref().unwrap_or_default())
            ));
        }
        out.push('\n');
    }

    out.push_str("=== DIARIZED MEETING TRANSCRIPT ===\n");
    if transcript.is_empty() {
        out.push_str("(none)\n");
    } else {
        let mut ordered = transcript.to_vec();
        ordered.sort_by_key(|segment| segment.seq_no);
        for segment in &ordered {
            let id = timestamp_evidence_id("T", segment.start_ms);
            out.push_str(&format!(
                "[{} - {} | {}] {}\n",
                id,
                format_timestamp(segment.end_ms),
                sanitize(&segment.speaker_label),
                sanitize(&segment.text)
            ));
        }
    }
    out.push('\n');

    out.push_str("=== KNOWN PARTICIPANTS ===\n");
    let participants: Vec<String> = index.speakers.iter().cloned().collect();
    if participants.is_empty() {
        out.push_str("You\n");
    } else {
        out.push_str(&participants.join(", "));
        out.push('\n');
    }

    SynthesisContext { text: out, index }
}

fn sanitize(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect::<String>()
        .trim()
        .replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meeting() -> Meeting {
        Meeting {
            id: "m1".into(),
            title: "Q3 Launch <script>".into(),
            status: "completed".into(),
            created_at: 0,
            updated_at: 0,
            duration_ms: 600_000,
            audio_file_path: None,
            screenshot_interval_sec: 10,
            asr_model_id: "parakeet".into(),
            slm_model_id: "gemma".into(),
            manual_notes_raw_md: String::new(),
            folder_id: None,
            is_starred: false,
        }
    }

    fn note(index: i64, offset: Option<i64>, text: &str) -> NoteBlock {
        NoteBlock {
            id: format!("n{index}"),
            meeting_id: "m1".into(),
            line_index: index,
            block_type: "paragraph".into(),
            content_md: text.into(),
            recording_offset_ms: offset,
            linked_screenshot_id: None,
        }
    }

    fn segment(seq: i64, start: i64, end: i64, speaker: &str, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: format!("t{seq}"),
            meeting_id: "m1".into(),
            seq_no: seq,
            start_ms: start,
            end_ms: end,
            speaker_id: None,
            speaker_label: speaker.into(),
            audio_channel: "system".into(),
            text: text.into(),
            is_confirmed: true,
        }
    }

    #[test]
    fn context_contains_exact_indexed_sections() {
        let notes = vec![
            note(
                1,
                Some(45_000),
                "Client wants Q3 launch moved to October 15.",
            ),
            note(
                2,
                Some(252_000),
                "DECISION: Use PostgreSQL instead of MongoDB for billing service.",
            ),
        ];
        let transcript = vec![
            segment(
                1,
                40_000,
                52_000,
                "Sarah",
                "We need to push the Q3 launch date to October 15th.",
            ),
            segment(
                2,
                245_000,
                265_000,
                "You",
                "Agreed, let's lock in PostgreSQL.",
            ),
            segment(
                3,
                560_000,
                578_000,
                "Alex",
                "I'll send the AWS cost sheet by Wednesday.",
            ),
        ];
        let screenshots = vec![Screenshot {
            id: "s1".into(),
            meeting_id: "m1".into(),
            start_ms: 250_000,
            end_ms: 260_000,
            file_path: "x.webp".into(),
            width: 1,
            height: 1,
            dhash: "0".into(),
            capture_trigger: "interval".into(),
            ocr_extracted_text: Some("Billing Architecture v2 — PostgreSQL + Redis".into()),
        }];
        let context = build_context(&meeting(), &notes, &transcript, &screenshots, &[]);

        assert!(context
            .text
            .contains("=== USER MANUAL NOTES (HIGHEST PRIORITY) ==="));
        assert!(context
            .text
            .contains("[N-L1 @ 00:45] Client wants Q3 launch moved to October 15."));
        assert!(context.text.contains("[N-L2 @ 04:12]"));
        assert!(context.text.contains("=== VISUAL SLIDE CAPTURES ==="));
        assert!(context.text.contains("[S-04:10] Billing Architecture v2"));
        assert!(context.text.contains("[T-00:40 - 00:52 | Sarah]"));
        assert!(context.text.contains("[T-09:20 - 09:38 | Alex]"));
        assert!(context.text.contains("=== KNOWN PARTICIPANTS ==="));
        assert!(context.text.contains("Sarah") && context.text.contains("Alex"));
        assert!(context.text.contains("Q3 Launch <script>"));
        assert!(context.index.contains("N-L1"));
        assert!(context.index.contains("T-09:20"));
        assert!(context.index.contains("S-04:10"));
    }

    #[test]
    fn empty_meeting_still_produces_a_valid_document() {
        let context = build_context(&meeting(), &[], &[], &[], &[]);
        assert!(context.text.contains("(none)"));
        assert!(context.text.contains("You"));
        assert!(context.index.sources.is_empty());
    }
}
