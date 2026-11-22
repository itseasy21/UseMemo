//! End-to-end acceptance: a synthetic 35-second meeting produces periodic
//! screenshots, deduplicates unchanged frames, and exports a Markdown vault with
//! relative WebP assets.

use std::fs;
use std::path::{Path, PathBuf};

use use_memo_lib::brand::Brand;
use use_memo_lib::export::{export_meeting, ExportMeeting};
use use_memo_lib::screenshot::{
    dhash_rgba, encode_webp, CaptureDecision, CaptureLease, CaptureScheduler, ScreenshotPathPlanner,
};
use use_memo_lib::storage::{Meeting, NoteBlock, Screenshot, SynthesisItem, TranscriptSegment};

fn frame(width: u32, height: u32, seed: u8) -> Vec<u8> {
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for _y in 0..height {
        for x in 0..width {
            // Sliding vertical stripes: each slide shifts the phase, which is
            // exactly what a horizontal difference hash detects.
            let stripe = ((x + seed as u32 * 20) / 24).is_multiple_of(2);
            let value = if stripe { 235 } else { 20 };
            rgba.extend_from_slice(&[value, value, value, 255]);
        }
    }
    rgba
}

#[test]
fn synthetic_35_second_session_exports_four_relative_webp_screenshots() {
    let root = tempfile::tempdir().unwrap();
    let vault = root.path().join("vault");
    let shot_root = root.path().join("capture");
    fs::create_dir_all(&shot_root).unwrap();
    let brand = Brand::embedded().unwrap();
    let planner = ScreenshotPathPlanner::new(shot_root.join("shots"));

    let meeting = Meeting {
        id: "0190f3a1-1111-7222-8333-444455556666".into(),
        title: "Synthetic 35s Review".into(),
        status: "completed".into(),
        created_at: 1_763_097_600_000,
        updated_at: 1_763_097_635_000,
        duration_ms: 35_000,
        audio_file_path: None,
        system_audio_file_path: None,
        system_audio_started_at_ms: 0,
        diarization_enabled: false,
        screenshot_interval_sec: 10,
        asr_model_id: "parakeet-tdt-0.6b-v3".into(),
        slm_model_id: "gemma-4-e2b-it".into(),
        manual_notes_raw_md: String::new(),
        folder_id: None,
        is_starred: false,
    };

    let lease = CaptureLease::new();
    let mut scheduler = CaptureScheduler::start(&lease, &meeting.id, 10, 0).unwrap();
    let mut screenshots: Vec<Screenshot> = Vec::new();
    let width = 320;
    let height = 180;

    for second in 0..=35i64 {
        let now_ms = second * 1_000;
        // A new slide every ten seconds; at 25s an unchanged manual snap must
        // be suppressed as a duplicate.
        let seed = (second / 10) as u8;
        let rgba = frame(width, height, seed);
        let hash = dhash_rgba(&rgba, width, height).unwrap();
        let decision = if second == 25 {
            let manual = scheduler.evaluate_manual(Some(hash));
            scheduler.record(now_ms, Some(hash), manual);
            assert_eq!(manual, CaptureDecision::SkipDuplicate);
            continue;
        } else {
            scheduler.evaluate(now_ms, Some(hash))
        };
        scheduler.record(now_ms, Some(hash), decision);
        if decision != CaptureDecision::Capture {
            continue;
        }
        let path = planner.plan(now_ms, hash);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, encode_webp(&rgba, width, height, 78.0).unwrap()).unwrap();
        screenshots.push(Screenshot {
            id: format!("shot-{second}"),
            meeting_id: meeting.id.clone(),
            start_ms: now_ms,
            end_ms: now_ms + 10_000,
            file_path: path.to_string_lossy().into_owned(),
            width: width as i64,
            height: height as i64,
            dhash: format!("{hash:016x}"),
            capture_trigger: "interval".into(),
            ocr_extracted_text: None,
        });
    }

    assert_eq!(scheduler.session().captured_count, 4);
    assert_eq!(scheduler.session().duplicate_count, 1);

    let notes = vec![NoteBlock {
        id: "note-1".into(),
        meeting_id: meeting.id.clone(),
        line_index: 0,
        block_type: "paragraph".into(),
        content_md: "Keep the export fully offline.".into(),
        recording_offset_ms: Some(12_000),
        linked_screenshot_id: None,
    }];
    let transcript = vec![TranscriptSegment {
        id: "seg-1".into(),
        meeting_id: meeting.id.clone(),
        seq_no: 0,
        start_ms: 0,
        end_ms: 8_000,
        speaker_id: Some("spk-1".into()),
        speaker_label: "Alice".into(),
        audio_channel: "microphone".into(),
        text: "The vault stays local.".into(),
        is_confirmed: true,
    }];
    let synthesis = vec![SynthesisItem {
        id: "item-1".into(),
        meeting_id: meeting.id.clone(),
        item_type: "action_item".into(),
        sort_order: 0,
        content: "Verify the WebP links.".into(),
        rationale: None,
        owner: Some("Alice".into()),
        deadline: Some("Not specified".into()),
        is_completed: false,
        is_user_edited: false,
        evidence_refs_json: serde_json::to_string(&["T-00:08"]).unwrap(),
    }];

    let outcome = export_meeting(ExportMeeting {
        brand: &brand,
        meeting: &meeting,
        notes: &notes,
        transcript: &transcript,
        screenshots: &screenshots,
        synthesis: &synthesis,
        vault_root: &vault,
        exported_at_ms: 1_763_097_636_000,
    })
    .unwrap();

    assert_eq!(outcome.copied_images, 4);
    assert!(outcome.missing_images.is_empty());
    let markdown = fs::read_to_string(&outcome.markdown_path).unwrap();
    assert_eq!(markdown.matches("](shots/").count(), 4);
    assert!(markdown.contains("## Screenshots"));
    assert!(markdown.contains("| Verify the WebP links. | Alice | Not specified | `[T-00:08]` |"));
    for path in screenshots
        .iter()
        .map(|shot| PathBuf::from(&shot.file_path))
    {
        assert!(path.is_file(), "capture missing: {}", path.display());
    }
    let exported_links: Vec<PathBuf> = markdown
        .lines()
        .filter(|line| line.starts_with("!["))
        .map(|line| {
            let link = line.split("](").nth(1).unwrap().trim_end_matches(')');
            Path::new(&outcome.folder).join(link)
        })
        .collect();
    assert_eq!(exported_links.len(), 4);
    for link in exported_links {
        let bytes = fs::read(&link).unwrap();
        assert_eq!(
            &bytes[8..12],
            b"WEBP",
            "not a WebP file: {}",
            link.display()
        );
    }
}
