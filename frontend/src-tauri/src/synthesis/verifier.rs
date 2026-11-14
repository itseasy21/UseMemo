use std::collections::BTreeSet;

use super::evidence::{normalize_evidence_id, normalize_name, EvidenceIndex};
use super::types::{
    RawItem, RawSynthesis, SynthesisItemDraft, VerificationReport, VerifiedSynthesis,
    DEADLINE_UNSPECIFIED, ITEM_ACTION, ITEM_DECISION, ITEM_SUMMARY, OWNER_UNASSIGNED,
};

/// Deterministic post-inference gate. Nothing reaches SQLite until every item has
/// at least one real evidence row, and every owner/deadline is grounded in that
/// evidence (or in the known speaker directory).
pub fn verify(raw: RawSynthesis, index: &EvidenceIndex) -> VerifiedSynthesis {
    let mut report = VerificationReport::default();
    let mut items = Vec::new();

    for (item_type, raw_items) in [
        (ITEM_SUMMARY, raw.summary),
        (ITEM_DECISION, raw.decisions),
        (ITEM_ACTION, raw.action_items),
    ] {
        let mut sort_order = 0i64;
        for item in raw_items {
            report.raw_items += 1;
            let Some(verified) = verify_item(item_type, item, sort_order, index, &mut report)
            else {
                report.dropped_without_valid_evidence += 1;
                continue;
            };
            report.kept_items += 1;
            sort_order += 1;
            items.push(verified);
        }
    }

    VerifiedSynthesis { items, report }
}

fn verify_item(
    item_type: &str,
    item: RawItem,
    sort_order: i64,
    index: &EvidenceIndex,
    report: &mut VerificationReport,
) -> Option<SynthesisItemDraft> {
    let content = item.content.trim();
    if content.is_empty() {
        return None;
    }

    let mut seen = BTreeSet::new();
    let mut evidence_refs = Vec::new();
    for raw_id in item.evidence_ids {
        let normalized = normalize_evidence_id(&raw_id);
        if !index.contains(&normalized) {
            report.stripped_evidence_refs += 1;
            continue;
        }
        if seen.insert(normalized.clone()) {
            evidence_refs.push(normalized);
        }
    }
    if evidence_refs.is_empty() {
        return None;
    }

    let (owner, deadline) = if item_type == ITEM_ACTION {
        let owner = ground_owner(item.owner.as_deref(), &evidence_refs, index, report);
        let deadline = ground_deadline(item.deadline.as_deref(), &evidence_refs, index, report);
        (Some(owner), Some(deadline))
    } else {
        (None, None)
    };

    Some(SynthesisItemDraft {
        item_type: item_type.to_string(),
        sort_order,
        content: content.replace('\n', " "),
        rationale: item
            .rationale
            .map(|rationale| rationale.trim().to_string())
            .filter(|rationale| !rationale.is_empty()),
        owner,
        deadline,
        is_completed: false,
        is_user_edited: false,
        evidence_refs,
    })
}

fn ground_owner(
    raw_owner: Option<&str>,
    evidence_refs: &[String],
    index: &EvidenceIndex,
    report: &mut VerificationReport,
) -> String {
    let candidate = raw_owner
        .unwrap_or_default()
        .trim()
        .trim_start_matches('@')
        .trim();
    if candidate.is_empty() || candidate.eq_ignore_ascii_case(OWNER_UNASSIGNED) {
        return OWNER_UNASSIGNED.to_string();
    }
    let normalized = normalize_name(candidate);
    let corpus = index.owner_corpus(evidence_refs).to_lowercase();
    let grounded = !normalized.is_empty()
        && (index.speaker_is_known(&normalized) || corpus.contains(&normalized));

    if grounded {
        candidate.to_string()
    } else {
        report.forced_unassigned_owners += 1;
        OWNER_UNASSIGNED.to_string()
    }
}

fn ground_deadline(
    raw_deadline: Option<&str>,
    evidence_refs: &[String],
    index: &EvidenceIndex,
    report: &mut VerificationReport,
) -> String {
    let candidate = raw_deadline
        .unwrap_or_default()
        .trim()
        .trim_matches(['[', ']'])
        .trim();
    if candidate.is_empty() || candidate.eq_ignore_ascii_case(DEADLINE_UNSPECIFIED) {
        return DEADLINE_UNSPECIFIED.to_string();
    }
    if !index.has_textual_evidence(evidence_refs) {
        report.forced_unspecified_deadlines += 1;
        return DEADLINE_UNSPECIFIED.to_string();
    }

    let corpus = index.deadline_corpus(evidence_refs).to_lowercase();
    let tokens: Vec<String> = candidate
        .to_lowercase()
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|c: char| c.is_ascii_punctuation())
                .to_string()
        })
        .filter(|token| !token.is_empty())
        .collect();

    let grounded = !tokens.is_empty() && tokens.iter().all(|token| corpus.contains(token));
    if grounded {
        candidate.to_string()
    } else {
        report.forced_unspecified_deadlines += 1;
        DEADLINE_UNSPECIFIED.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{NoteBlock, Screenshot, TranscriptSegment};

    fn action(content: &str, owner: &str, deadline: &str, refs: &[&str]) -> RawItem {
        RawItem {
            content: content.into(),
            rationale: None,
            evidence_ids: refs.iter().map(|id| (*id).to_string()).collect(),
            owner: Some(owner.into()),
            deadline: Some(deadline.into()),
        }
    }

    fn item(content: &str, refs: &[&str]) -> RawItem {
        RawItem {
            content: content.into(),
            rationale: None,
            evidence_ids: refs.iter().map(|id| (*id).to_string()).collect(),
            owner: None,
            deadline: None,
        }
    }

    fn index() -> EvidenceIndex {
        let notes = vec![
            NoteBlock {
                id: "n1".into(),
                meeting_id: "m".into(),
                line_index: 1,
                block_type: "paragraph".into(),
                content_md: "Client wants Q3 launch moved to October 15.".into(),
                recording_offset_ms: Some(45_000),
                linked_screenshot_id: None,
            },
            NoteBlock {
                id: "n2".into(),
                meeting_id: "m".into(),
                line_index: 2,
                block_type: "decision".into(),
                content_md: "DECISION: Use PostgreSQL instead of MongoDB for billing service."
                    .into(),
                recording_offset_ms: Some(252_000),
                linked_screenshot_id: None,
            },
        ];
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
                text:
                    "We need to push the Q3 launch date to October 15th to finish security testing."
                        .into(),
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
    fn acceptance_check_invented_owner_and_deadline_are_deterministically_replaced() {
        let raw = RawSynthesis {
            summary: vec![],
            decisions: vec![],
            action_items: vec![action(
                "Send the revised AWS cost sheet.",
                "Bob",
                "Next Friday",
                &["T-09:20"],
            )],
        };
        let verified = verify(raw, &index());
        assert_eq!(verified.items.len(), 1);
        let item = &verified.items[0];
        assert_eq!(item.owner.as_deref(), Some(OWNER_UNASSIGNED));
        assert_eq!(item.deadline.as_deref(), Some(DEADLINE_UNSPECIFIED));
        assert_eq!(verified.report.forced_unassigned_owners, 1);
        assert_eq!(verified.report.forced_unspecified_deadlines, 1);
        assert_eq!(verified.report.kept_items, 1);
    }

    #[test]
    fn grounded_owner_and_deadline_survive_verbatim() {
        let raw = RawSynthesis {
            summary: vec![item(
                "Q3 launch moved to October 15th to finish security testing.",
                &["T-00:40"],
            )],
            decisions: vec![item(
                "Use PostgreSQL for the billing service.",
                &["N-L2", "S-04:10"],
            )],
            action_items: vec![action(
                "Send the revised AWS cost sheet.",
                "Alex",
                "Wednesday",
                &["T-09:20"],
            )],
        };
        let verified = verify(raw, &index());
        assert_eq!(verified.items.len(), 3);
        let action = verified.action_items()[0];
        assert_eq!(action.owner.as_deref(), Some("Alex"));
        assert_eq!(action.deadline.as_deref(), Some("Wednesday"));
        assert_eq!(verified.report.forced_unassigned_owners, 0);
        assert_eq!(verified.report.forced_unspecified_deadlines, 0);
        assert_eq!(verified.summary()[0].evidence_refs, vec!["T-00:40"]);
    }

    #[test]
    fn items_without_any_real_evidence_are_discarded() {
        let raw = RawSynthesis {
            summary: vec![item("Invented fact", &["T-99:99"]), item("", &["T-00:40"])],
            decisions: vec![RawItem {
                content: "No refs at all".into(),
                ..Default::default()
            }],
            action_items: vec![action("Ghost task", "Alex", "Wednesday", &["FAKE-1"])],
        };
        let verified = verify(raw, &index());
        assert!(verified.items.is_empty());
        assert_eq!(verified.report.raw_items, 4);
        assert_eq!(verified.report.dropped_without_valid_evidence, 4);
        assert_eq!(verified.report.stripped_evidence_refs, 2);
    }

    #[test]
    fn invalid_refs_are_stripped_while_valid_refs_keep_the_item() {
        let raw = RawSynthesis {
            summary: vec![item("Grounded summary", &["T-00:40", "S-04:10", "T-01:00"])],
            ..Default::default()
        };
        let verified = verify(raw, &index());
        assert_eq!(verified.items[0].evidence_refs, vec!["T-00:40", "S-04:10"]);
        assert_eq!(verified.report.stripped_evidence_refs, 1);
    }

    #[test]
    fn adjacent_segment_can_ground_a_deadline() {
        let raw = RawSynthesis {
            action_items: vec![action(
                "Send the cost sheet.",
                "Alex",
                "Wednesday afternoon",
                &["T-04:05"],
            )],
            ..Default::default()
        };
        let verified = verify(raw, &index());
        assert_eq!(
            verified.items[0].deadline.as_deref(),
            Some("Wednesday afternoon")
        );
        assert_eq!(verified.report.forced_unspecified_deadlines, 0);
    }

    #[test]
    fn screenshot_only_evidence_cannot_ground_owner_or_deadline() {
        let raw = RawSynthesis {
            action_items: vec![action("Review slide", "Bob", "Wednesday", &["S-04:10"])],
            ..Default::default()
        };
        let verified = verify(raw, &index());
        assert_eq!(verified.items[0].owner.as_deref(), Some(OWNER_UNASSIGNED));
        assert_eq!(
            verified.items[0].deadline.as_deref(),
            Some(DEADLINE_UNSPECIFIED)
        );
    }

    #[test]
    fn placeholders_and_at_prefix_are_normalized() {
        let raw = RawSynthesis {
            action_items: vec![
                action("Task A", "Unassigned", "Not specified", &["T-09:20"]),
                action("Task B", "@Alex", "Wednesday", &["T-09:20"]),
            ],
            ..Default::default()
        };
        let verified = verify(raw, &index());
        assert_eq!(verified.items[0].owner.as_deref(), Some(OWNER_UNASSIGNED));
        assert_eq!(
            verified.items[0].deadline.as_deref(),
            Some(DEADLINE_UNSPECIFIED)
        );
        assert_eq!(verified.items[1].owner.as_deref(), Some("Alex"));
        assert_eq!(verified.report.forced_unassigned_owners, 0);
        assert_eq!(verified.report.forced_unspecified_deadlines, 0);
    }

    #[test]
    fn non_action_items_never_carry_owner_or_deadline() {
        let raw = RawSynthesis {
            summary: vec![RawItem {
                content: "Summary".into(),
                owner: Some("Alex".into()),
                deadline: Some("Wednesday".into()),
                evidence_ids: vec!["T-00:40".into()],
                ..Default::default()
            }],
            ..Default::default()
        };
        let verified = verify(raw, &index());
        assert_eq!(verified.items[0].owner, None);
        assert_eq!(verified.items[0].deadline, None);
    }
}
