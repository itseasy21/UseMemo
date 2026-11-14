use std::collections::{BTreeMap, BTreeSet};

use crate::storage::{NoteBlock, Screenshot, Speaker, TranscriptSegment};

pub const KIND_TRANSCRIPT: &str = "transcript";
pub const KIND_NOTE: &str = "note";
pub const KIND_SCREENSHOT: &str = "screenshot";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceKind {
    Transcript,
    Note,
    Screenshot,
}

#[derive(Debug, Clone)]
pub struct EvidenceSource {
    pub id: String,
    pub kind: EvidenceKind,
    pub text: String,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub seq_no: Option<i64>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct EvidenceIndex {
    pub sources: BTreeMap<String, EvidenceSource>,
    pub speakers: BTreeSet<String>,
    transcript_by_seq: BTreeMap<i64, String>,
    transcript_seq_by_id: BTreeMap<String, i64>,
}

impl EvidenceIndex {
    pub fn from_records(
        notes: &[NoteBlock],
        transcript: &[TranscriptSegment],
        screenshots: &[Screenshot],
        speakers: &[Speaker],
    ) -> Self {
        let mut index = Self::default();

        for speaker in speakers {
            index.speakers.insert(speaker.display_name.clone());
        }

        for note in notes {
            let id = note_evidence_id(note.line_index);
            index.insert(EvidenceSource {
                id,
                kind: EvidenceKind::Note,
                text: note.content_md.clone(),
                start_ms: note.recording_offset_ms,
                end_ms: None,
                seq_no: None,
                label: Some(format!("N-L{}", note.line_index)),
            });
        }

        for segment in transcript {
            let id = timestamp_evidence_id("T", segment.start_ms);
            index.speakers.insert(segment.speaker_label.clone());
            index
                .transcript_by_seq
                .insert(segment.seq_no, segment.text.clone());
            index
                .transcript_seq_by_id
                .insert(id.clone(), segment.seq_no);
            index.insert(EvidenceSource {
                id,
                kind: EvidenceKind::Transcript,
                text: segment.text.clone(),
                start_ms: Some(segment.start_ms),
                end_ms: Some(segment.end_ms),
                seq_no: Some(segment.seq_no),
                label: Some(segment.speaker_label.clone()),
            });
        }

        for screenshot in screenshots {
            let id = timestamp_evidence_id("S", screenshot.start_ms);
            index.insert(EvidenceSource {
                id,
                kind: EvidenceKind::Screenshot,
                text: screenshot.ocr_extracted_text.clone().unwrap_or_default(),
                start_ms: Some(screenshot.start_ms),
                end_ms: Some(screenshot.end_ms),
                seq_no: None,
                label: Some("slide".into()),
            });
        }

        index
    }

    fn insert(&mut self, mut source: EvidenceSource) {
        source.id = normalize_evidence_id(&source.id);
        if let Some(existing) = self.sources.get_mut(&source.id) {
            if existing.text.is_empty() {
                existing.text = source.text;
            } else if !source.text.is_empty() && !existing.text.contains(&source.text) {
                existing.text.push('\n');
                existing.text.push_str(&source.text);
            }
            existing.end_ms = existing.end_ms.max(source.end_ms);
            return;
        }
        self.sources.insert(source.id.clone(), source);
    }

    pub fn get(&self, evidence_id: &str) -> Option<&EvidenceSource> {
        self.sources.get(&normalize_evidence_id(evidence_id))
    }

    pub fn contains(&self, evidence_id: &str) -> bool {
        self.get(evidence_id).is_some()
    }

    pub fn cited_sources<'a>(&'a self, refs: &[String]) -> Vec<&'a EvidenceSource> {
        refs.iter().filter_map(|id| self.get(id)).collect()
    }

    /// Owner grounding corpus: cited transcript and note text only. Screenshots
    /// are visual evidence, not proof that a person owns an action.
    pub fn owner_corpus(&self, refs: &[String]) -> String {
        self.cited_sources(refs)
            .into_iter()
            .filter(|source| source.kind != EvidenceKind::Screenshot)
            .map(|source| source.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Deadline grounding corpus: cited transcript segments plus one adjacent
    /// segment on each side (people often state the deadline in the next sentence),
    /// plus cited manual notes. Screenshots are excluded.
    pub fn deadline_corpus(&self, refs: &[String]) -> String {
        let mut parts: Vec<String> = Vec::new();
        for source in self.cited_sources(refs) {
            match source.kind {
                EvidenceKind::Transcript => {
                    if let Some(seq) = source.seq_no {
                        for neighbor in (seq - 1)..=(seq + 1) {
                            if let Some(text) = self.transcript_by_seq.get(&neighbor) {
                                parts.push(text.clone());
                            }
                        }
                    } else {
                        parts.push(source.text.clone());
                    }
                }
                EvidenceKind::Note => parts.push(source.text.clone()),
                EvidenceKind::Screenshot => {}
            }
        }
        parts.join("\n")
    }

    pub fn has_textual_evidence(&self, refs: &[String]) -> bool {
        self.cited_sources(refs)
            .iter()
            .any(|source| matches!(source.kind, EvidenceKind::Transcript | EvidenceKind::Note))
    }

    pub fn speaker_is_known(&self, name: &str) -> bool {
        let name = normalize_name(name);
        !name.is_empty()
            && self.speakers.iter().any(|speaker| {
                normalize_name(speaker).contains(&name) || name.contains(&normalize_name(speaker))
            })
    }

    pub fn transcript_seq_for(&self, evidence_id: &str) -> Option<i64> {
        self.transcript_seq_by_id
            .get(&normalize_evidence_id(evidence_id))
            .copied()
    }
}

pub fn timestamp_evidence_id(prefix: &str, ms: i64) -> String {
    format!("{}-{}", prefix, format_timestamp(ms))
}

pub fn note_evidence_id(line_index: i64) -> String {
    format!("N-L{}", line_index.max(1))
}

pub fn format_timestamp(ms: i64) -> String {
    let total_seconds = ms.max(0) / 1000;
    format!("{:02}:{:02}", total_seconds / 60, total_seconds % 60)
}

pub fn normalize_evidence_id(id: &str) -> String {
    id.trim().trim_matches(['[', ']', ' ']).to_ascii_uppercase()
}

pub fn normalize_name(name: &str) -> String {
    name.trim()
        .trim_start_matches('@')
        .trim_matches(|c: char| c.is_ascii_punctuation() && c != '-' && c != '\'')
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> EvidenceIndex {
        let notes = vec![NoteBlock {
            id: "n1".into(),
            meeting_id: "m".into(),
            line_index: 2,
            block_type: "decision".into(),
            content_md: "DECISION: Use PostgreSQL for billing.".into(),
            recording_offset_ms: Some(252_000),
            linked_screenshot_id: None,
        }];
        let transcript = vec![
            TranscriptSegment {
                id: "t1".into(),
                meeting_id: "m".into(),
                seq_no: 1,
                start_ms: 40_000,
                end_ms: 52_000,
                speaker_id: None,
                speaker_label: "Sarah".into(),
                audio_channel: "system".into(),
                text: "We need to push the Q3 launch date to October 15th.".into(),
                is_confirmed: true,
            },
            TranscriptSegment {
                id: "t2".into(),
                meeting_id: "m".into(),
                seq_no: 2,
                start_ms: 245_000,
                end_ms: 265_000,
                speaker_id: None,
                speaker_label: "You".into(),
                audio_channel: "mic".into(),
                text: "Agreed, let's lock in PostgreSQL for the billing microservice.".into(),
                is_confirmed: true,
            },
            TranscriptSegment {
                id: "t3".into(),
                meeting_id: "m".into(),
                seq_no: 3,
                start_ms: 560_000,
                end_ms: 578_000,
                speaker_id: None,
                speaker_label: "Alex".into(),
                audio_channel: "system".into(),
                text: "I'll send over the updated AWS cost spreadsheet by Wednesday afternoon."
                    .into(),
                is_confirmed: true,
            },
        ];
        let screenshots = vec![Screenshot {
            id: "s1".into(),
            meeting_id: "m".into(),
            start_ms: 250_000,
            end_ms: 260_000,
            file_path: "x.webp".into(),
            width: 1,
            height: 1,
            dhash: "0".into(),
            capture_trigger: "interval".into(),
            ocr_extracted_text: Some("Billing Architecture v2 — PostgreSQL + Redis".into()),
        }];
        EvidenceIndex::from_records(&notes, &transcript, &screenshots, &[])
    }

    #[test]
    fn ids_use_spec_shapes_and_are_normalized() {
        assert_eq!(format_timestamp(245_000), "04:05");
        assert_eq!(timestamp_evidence_id("T", 245_000), "T-04:05");
        assert_eq!(note_evidence_id(2), "N-L2");
        assert_eq!(normalize_evidence_id(" [t-04:05] "), "T-04:05");
    }

    #[test]
    fn index_resolves_all_three_evidence_kinds() {
        let index = fixture();
        assert!(index.contains("T-00:40"));
        assert!(index.contains("N-L2"));
        assert!(index.contains("S-04:10"));
        assert!(!index.contains("T-99:99"));
        assert!(index.speaker_is_known("Sarah"));
        assert!(index.speaker_is_known("You"));
        assert!(!index.speaker_is_known("Bob"));
    }

    #[test]
    fn deadline_corpus_includes_adjacent_transcript_segments() {
        let index = fixture();
        let corpus = index.deadline_corpus(&["T-04:05".into()]);
        assert!(corpus.contains("October 15th"));
        assert!(corpus.contains("Wednesday afternoon"));
    }

    #[test]
    fn owner_corpus_excludes_screenshots() {
        let index = fixture();
        let corpus = index.owner_corpus(&["S-04:10".into()]);
        assert!(corpus.is_empty());
        assert!(!index.has_textual_evidence(&["S-04:10".into()]));
    }
}
