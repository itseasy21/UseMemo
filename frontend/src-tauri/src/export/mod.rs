//! Markdown vault exporter.
//!
//! One meeting becomes one folder:
//!
//! ```text
//! <vault>/meetings/2026-11-14-design-review-0190f3a1/
//!   index.md
//!   shots/shot-000010-0123456789abcdef.webp
//! ```
//!
//! Frontmatter is deterministic YAML; images are referenced relatively so the
//! vault can be synced, zipped, or opened in Obsidian without rewriting links.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::brand::Brand;
use crate::error::AppResult;
use crate::screenshot::encode::encode_webp;
use crate::screenshot::paths::{relative_link, sanitize_filename};
use crate::storage::{Meeting, NoteBlock, Screenshot, SynthesisItem, TranscriptSegment};

pub struct ExportMeeting<'a> {
    pub brand: &'a Brand,
    pub meeting: &'a Meeting,
    pub notes: &'a [NoteBlock],
    pub transcript: &'a [TranscriptSegment],
    pub screenshots: &'a [Screenshot],
    pub synthesis: &'a [SynthesisItem],
    pub vault_root: &'a Path,
    pub exported_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub folder: String,
    pub markdown_path: String,
    pub markdown_bytes: usize,
    pub copied_images: usize,
    pub missing_images: Vec<String>,
}

struct PreparedImage {
    link: String,
    missing: Option<String>,
}

pub fn export_meeting(input: ExportMeeting<'_>) -> AppResult<ExportOutcome> {
    let meeting = input.meeting;
    let folder = meeting_folder(input.vault_root, meeting);
    let shots_dir = folder.join("shots");
    fs::create_dir_all(&shots_dir)?;

    let mut images = Vec::with_capacity(input.screenshots.len());
    let mut copied = 0usize;
    let mut missing = Vec::new();
    let mut used_names = BTreeSet::new();
    let mut ordered_shots: Vec<&Screenshot> = input.screenshots.iter().collect();
    ordered_shots.sort_by_key(|shot| (shot.start_ms, shot.id.as_str()));

    for shot in ordered_shots {
        let source = Path::new(&shot.file_path);
        if !source.is_file() {
            missing.push(shot.file_path.clone());
            images.push(PreparedImage {
                link: String::new(),
                missing: Some(shot.file_path.clone()),
            });
            continue;
        }
        let destination = match prepare_image(source, &shots_dir, &mut used_names) {
            Ok(destination) => destination,
            Err(error) => {
                missing.push(format!("{}: {error}", shot.file_path));
                images.push(PreparedImage {
                    link: String::new(),
                    missing: Some(shot.file_path.clone()),
                });
                continue;
            }
        };
        copied += 1;
        images.push(PreparedImage {
            link: relative_link(&folder, &destination)?,
            missing: None,
        });
    }

    let markdown = render_markdown(&input, &images);
    let markdown_path = folder.join("index.md");
    write_atomic(&markdown_path, markdown.as_bytes())?;

    Ok(ExportOutcome {
        folder: folder.to_string_lossy().into_owned(),
        markdown_path: markdown_path.to_string_lossy().into_owned(),
        markdown_bytes: markdown.len(),
        copied_images: copied,
        missing_images: missing,
    })
}

pub fn meeting_folder(vault_root: &Path, meeting: &Meeting) -> PathBuf {
    let date = DateTime::<Utc>::from_timestamp_millis(meeting.created_at)
        .map(|value| value.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "undated".into());
    let slug = sanitize_filename(&meeting.title, "memo");
    let short_id: String = meeting.id.chars().take(8).collect();
    vault_root
        .join("meetings")
        .join(format!("{date}-{slug}-{short_id}"))
}

fn render_markdown(input: &ExportMeeting<'_>, images: &[PreparedImage]) -> String {
    let meeting = input.meeting;
    let manifest = input.brand.manifest();
    let mut out = String::with_capacity(4_096);
    let mut ordered_synthesis: Vec<&SynthesisItem> = input.synthesis.iter().collect();
    ordered_synthesis.sort_by_key(|item| (item.sort_order, item.id.as_str()));
    let mut ordered_notes: Vec<&NoteBlock> = input.notes.iter().collect();
    ordered_notes.sort_by_key(|note| (note.line_index, note.id.as_str()));
    let mut ordered_transcript: Vec<&TranscriptSegment> = input.transcript.iter().collect();
    ordered_transcript.sort_by_key(|segment| (segment.seq_no, segment.start_ms));
    let mut ordered_shots: Vec<&Screenshot> = input.screenshots.iter().collect();
    ordered_shots.sort_by_key(|shot| (shot.start_ms, shot.id.as_str()));

    out.push_str("---\n");
    out.push_str(&format!("title: {}\n", yaml_string(&meeting.title)));
    out.push_str(&format!("meeting_id: {}\n", yaml_string(&meeting.id)));
    out.push_str(&format!(
        "created_at: {}\n",
        yaml_string(&timestamp(meeting.created_at))
    ));
    out.push_str(&format!("duration_ms: {}\n", meeting.duration_ms.max(0)));
    out.push_str(&format!(
        "duration: {}\n",
        yaml_string(&format_duration(meeting.duration_ms))
    ));
    out.push_str(&format!("status: {}\n", yaml_string(&meeting.status)));
    out.push_str(&format!(
        "asr_model: {}\n",
        yaml_string(&meeting.asr_model_id)
    ));
    out.push_str(&format!(
        "slm_model: {}\n",
        yaml_string(&meeting.slm_model_id)
    ));
    out.push_str(&format!(
        "screenshot_interval_sec: {}\n",
        meeting.screenshot_interval_sec
    ));
    out.push_str(&format!("screenshots: {}\n", input.screenshots.len()));
    out.push_str("participants:\n");
    let participants = participants(&ordered_transcript);
    if participants.is_empty() {
        out.push_str("  []\n");
    } else {
        for participant in &participants {
            out.push_str(&format!("  - {}\n", yaml_string(participant)));
        }
    }
    out.push_str(&format!("app: {}\n", yaml_string(&manifest.product_name)));
    out.push_str(&format!(
        "license: {}\n",
        yaml_string(&manifest.license_type)
    ));
    out.push_str(&format!(
        "exported_at: {}\n",
        yaml_string(&timestamp(input.exported_at_ms))
    ));
    out.push_str("---\n\n");

    out.push_str(&format!("# {}\n\n", meeting.title.trim()));
    out.push_str(&format!(
        "**Recorded:** {} · **Duration:** {} · **Status:** {}\n\n",
        timestamp(meeting.created_at),
        format_duration(meeting.duration_ms),
        meeting.status
    ));

    if !ordered_synthesis.is_empty() {
        out.push_str("## Synthesis\n\n");
        for (label, kind) in [
            ("Summary", "summary"),
            ("Decisions", "decision"),
            ("Action Items", "action_item"),
        ] {
            let items: Vec<&&SynthesisItem> = ordered_synthesis
                .iter()
                .filter(|item| item.item_type == kind)
                .collect();
            if items.is_empty() {
                continue;
            }
            out.push_str(&format!("### {label}\n\n"));
            if kind == "action_item" {
                out.push_str("| Action | Owner | Deadline | Evidence |\n");
                out.push_str("| --- | --- | --- | --- |\n");
                for item in items {
                    out.push_str(&format!(
                        "| {} | {} | {} | {} |\n",
                        table_cell(&item.content),
                        table_cell(item.owner.as_deref().unwrap_or("Unassigned")),
                        table_cell(item.deadline.as_deref().unwrap_or("Not specified")),
                        table_cell(&evidence_refs(item)),
                    ));
                }
                out.push('\n');
            } else {
                for item in items {
                    out.push_str(&format!(
                        "- {}{}\n",
                        item.content.trim(),
                        evidence_suffix(item)
                    ));
                }
                out.push('\n');
            }
        }
    }

    if !ordered_notes.is_empty() {
        out.push_str("## Notes\n\n");
        for note in ordered_notes {
            let prefix = note
                .recording_offset_ms
                .map(|offset| format!("`[{}]` ", format_timestamp(offset)));
            match note.block_type.as_str() {
                "heading" => out.push_str(&format!("### {}\n\n", note.content_md.trim())),
                "quote" => out.push_str(&format!("> {}\n\n", note.content_md.trim())),
                "bullet" => out.push_str(&format!("- {}\n", note.content_md.trim())),
                _ => out.push_str(&format!(
                    "{}{}\n\n",
                    prefix.as_deref().unwrap_or(""),
                    note.content_md.trim()
                )),
            }
        }
    }

    if !ordered_transcript.is_empty() {
        out.push_str("## Transcript\n\n");
        for segment in ordered_transcript {
            let speaker = if segment.speaker_label.trim().is_empty() {
                "Unknown speaker"
            } else {
                segment.speaker_label.trim()
            };
            out.push_str(&format!(
                "**[{}–{}] {}** · {}\n\n{}\n\n",
                format_timestamp(segment.start_ms),
                format_timestamp(segment.end_ms.max(segment.start_ms)),
                speaker,
                segment.audio_channel,
                segment.text.trim()
            ));
        }
    }

    if !ordered_shots.is_empty() {
        out.push_str("## Screenshots\n\n");
        for (index, shot) in ordered_shots.iter().enumerate() {
            out.push_str(&format!(
                "### {}–{}\n\n",
                format_timestamp(shot.start_ms),
                format_timestamp(shot.end_ms.max(shot.start_ms))
            ));
            match images.get(index).and_then(|image| image.missing.as_ref()) {
                Some(missing) => out.push_str(&format!(
                    "_Screenshot file missing: {}_\n\n",
                    missing.replace('|', "\\|")
                )),
                None => {
                    let link = images
                        .get(index)
                        .map(|image| image.link.as_str())
                        .unwrap_or_default();
                    out.push_str(&format!(
                        "![Screenshot at {}]({})\n\n",
                        format_timestamp(shot.start_ms),
                        link
                    ));
                }
            }
            if let Some(ocr) = shot.ocr_extracted_text.as_deref() {
                if !ocr.trim().is_empty() {
                    out.push_str(&format!("**OCR:** {}\n\n", ocr.trim()));
                }
            }
        }
    }

    out
}

fn prepare_image(
    source: &Path,
    shots_dir: &Path,
    used_names: &mut BTreeSet<String>,
) -> AppResult<PathBuf> {
    let stem = source
        .file_stem()
        .map(|value| sanitize_filename(&value.to_string_lossy(), "shot"))
        .unwrap_or_else(|| "shot".into());
    let mut name = format!("{stem}.webp");
    let mut suffix = 1;
    while used_names.contains(&name) {
        name = format!("{stem}-{suffix}.webp");
        suffix += 1;
    }
    used_names.insert(name.clone());
    let destination = shots_dir.join(name);
    if source == destination {
        return Ok(destination);
    }
    if source
        .extension()
        .map(|extension| extension.eq_ignore_ascii_case("webp"))
        .unwrap_or(false)
    {
        fs::copy(source, &destination)?;
    } else {
        let image = image::open(source)?;
        let rgba = image.to_rgba8();
        let bytes = encode_webp(rgba.as_raw(), rgba.width(), rgba.height(), 82.0)?;
        fs::write(&destination, bytes)?;
    }
    Ok(destination)
}

fn participants(transcript: &[&TranscriptSegment]) -> BTreeSet<String> {
    transcript
        .iter()
        .map(|segment| segment.speaker_label.trim().to_string())
        .filter(|label| !label.is_empty() && label != "Unknown speaker")
        .collect()
}

fn evidence_refs(item: &SynthesisItem) -> String {
    let refs = item.evidence_refs();
    if refs.is_empty() {
        "none".into()
    } else {
        refs.iter()
            .map(|reference| format!("`[{reference}]`"))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn evidence_suffix(item: &SynthesisItem) -> String {
    let refs = item.evidence_refs();
    if refs.is_empty() {
        String::new()
    } else {
        format!(
            " — {}",
            refs.iter()
                .map(|reference| format!("`[{reference}]`"))
                .collect::<Vec<_>>()
                .join(" ")
        )
    }
}

fn table_cell(value: &str) -> String {
    value
        .replace('|', "\\|")
        .replace(['\n', '\r'], " ")
        .trim()
        .to_string()
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

fn timestamp(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into())
}

pub fn format_duration(ms: i64) -> String {
    let total_seconds = (ms.max(0) / 1_000) as u64;
    let hours = total_seconds / 3_600;
    let minutes = (total_seconds % 3_600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn format_timestamp(ms: i64) -> String {
    crate::synthesis::evidence::format_timestamp(ms)
}

fn write_atomic(path: &Path, contents: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("md.tmp");
    fs::write(&temporary, contents)?;
    if fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(path);
        fs::rename(&temporary, path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screenshot::encode::encode_webp;

    fn meeting() -> Meeting {
        Meeting {
            id: "0190f3a1-aaaa-bbbb-cccc-ddddeeeeffff".into(),
            title: "Design Review — Q4".into(),
            status: "completed".into(),
            created_at: 1_763_097_600_000,
            updated_at: 1_763_097_635_000,
            duration_ms: 35_000,
            audio_file_path: None,
            screenshot_interval_sec: 10,
            asr_model_id: "parakeet-tdt-0.6b-v3".into(),
            slm_model_id: "gemma-4-e2b-it".into(),
            manual_notes_raw_md: String::new(),
            folder_id: None,
            is_starred: false,
        }
    }

    fn note() -> NoteBlock {
        NoteBlock {
            id: "note-1".into(),
            meeting_id: meeting().id,
            line_index: 0,
            block_type: "paragraph".into(),
            content_md: "Ship the offline build.".into(),
            recording_offset_ms: Some(12_000),
            linked_screenshot_id: None,
        }
    }

    fn segment() -> TranscriptSegment {
        TranscriptSegment {
            id: "seg-1".into(),
            meeting_id: meeting().id,
            seq_no: 0,
            start_ms: 0,
            end_ms: 8_000,
            speaker_id: Some("speaker-1".into()),
            speaker_label: "Alice".into(),
            audio_channel: "microphone".into(),
            text: "We agreed to ship the offline build on October 15th.".into(),
            is_confirmed: true,
        }
    }

    fn synthesis() -> SynthesisItem {
        SynthesisItem {
            id: "item-1".into(),
            meeting_id: meeting().id,
            item_type: "action_item".into(),
            sort_order: 0,
            content: "Send the revised deck.".into(),
            rationale: None,
            owner: Some("Alice".into()),
            deadline: Some("Not specified".into()),
            is_completed: false,
            is_user_edited: false,
            evidence_refs_json: serde_json::to_string(&["T-00:08"]).unwrap(),
        }
    }

    fn screenshot(id: &str, start_ms: i64, path: &Path) -> Screenshot {
        Screenshot {
            id: id.into(),
            meeting_id: meeting().id,
            start_ms,
            end_ms: start_ms + 10_000,
            file_path: path.to_string_lossy().into_owned(),
            width: 320,
            height: 180,
            dhash: format!("{start_ms:016x}"),
            capture_trigger: "interval".into(),
            ocr_extracted_text: None,
        }
    }

    fn write_frame(dir: &Path, name: &str, seed: u8) -> PathBuf {
        let width = 320u32;
        let height = 180u32;
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                rgba.extend_from_slice(&[
                    ((x + seed as u32) % 256) as u8,
                    (y % 256) as u8,
                    seed,
                    255,
                ]);
            }
        }
        let bytes = encode_webp(&rgba, width, height, 80.0).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn exports_frontmatter_body_and_relative_webp_images() {
        let vault = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let brand = Brand::embedded().unwrap();
        let meeting = meeting();
        let notes = vec![note()];
        let transcript = vec![segment()];
        let synthesis_items = vec![synthesis()];
        let frames = vec![
            screenshot("shot-1", 0, &write_frame(source_dir.path(), "a.webp", 1)),
            screenshot(
                "shot-2",
                10_000,
                &write_frame(source_dir.path(), "b.webp", 90),
            ),
            screenshot(
                "shot-3",
                20_000,
                &write_frame(source_dir.path(), "c.webp", 180),
            ),
            screenshot(
                "shot-4",
                30_000,
                &write_frame(source_dir.path(), "d.webp", 250),
            ),
        ];

        let outcome = export_meeting(ExportMeeting {
            brand: &brand,
            meeting: &meeting,
            notes: &notes,
            transcript: &transcript,
            screenshots: &frames,
            synthesis: &synthesis_items,
            vault_root: vault.path(),
            exported_at_ms: 1_763_097_700_000,
        })
        .unwrap();

        assert_eq!(outcome.copied_images, 4);
        assert!(outcome.missing_images.is_empty());
        assert_eq!(
            Path::new(&outcome.markdown_path),
            Path::new(&outcome.folder).join("index.md")
        );
        let markdown = fs::read_to_string(&outcome.markdown_path).unwrap();
        assert!(markdown.starts_with("---\n"));
        assert!(markdown.contains("title: \"Design Review — Q4\""));
        assert!(markdown.contains(&format!("app: \"{}\"", brand.manifest().product_name)));
        assert!(markdown.contains("participants:\n  - \"Alice\""));
        assert!(
            markdown.contains("| Send the revised deck. | Alice | Not specified | `[T-00:08]` |")
        );
        assert!(markdown.contains("## Transcript"));
        assert!(markdown.contains("**[00:00–00:08] Alice**"));
        assert!(markdown.contains("## Screenshots"));
        assert_eq!(markdown.matches("](shots/").count(), 4);
        assert!(!markdown.contains(&format!(
            "{} {}",
            brand.manifest().company_name,
            env!("CARGO_PKG_VERSION")
        )));
        for line in markdown.lines().filter(|line| line.starts_with("![")) {
            let link = line.split("](").nth(1).unwrap().trim_end_matches(')');
            let path = Path::new(&outcome.folder).join(link);
            assert!(path.is_file(), "missing {}", path.display());
            let bytes = fs::read(&path).unwrap();
            assert_eq!(&bytes[8..12], b"WEBP");
        }
    }

    #[test]
    fn missing_images_are_reported_without_aborting_the_export() {
        let vault = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let brand = Brand::embedded().unwrap();
        let meeting = meeting();
        let frames = vec![
            screenshot("shot-1", 0, &write_frame(source_dir.path(), "a.webp", 1)),
            screenshot("shot-2", 10_000, Path::new("/does/not/exist.webp")),
        ];
        let outcome = export_meeting(ExportMeeting {
            brand: &brand,
            meeting: &meeting,
            notes: &[],
            transcript: &[],
            screenshots: &frames,
            synthesis: &[],
            vault_root: vault.path(),
            exported_at_ms: 0,
        })
        .unwrap();
        assert_eq!(outcome.copied_images, 1);
        assert_eq!(outcome.missing_images.len(), 1);
        let markdown = fs::read_to_string(&outcome.markdown_path).unwrap();
        assert!(markdown.contains("_Screenshot file missing: /does/not/exist.webp_"));
    }

    #[test]
    fn non_webp_sources_are_transcoded() {
        let vault = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let brand = Brand::embedded().unwrap();
        let meeting = meeting();
        let png = source_dir.path().join("frame.png");
        image::RgbaImage::from_pixel(64, 48, image::Rgba([1, 2, 3, 255]))
            .save(&png)
            .unwrap();
        let frames = vec![screenshot("shot-1", 0, &png)];
        let outcome = export_meeting(ExportMeeting {
            brand: &brand,
            meeting: &meeting,
            notes: &[],
            transcript: &[],
            screenshots: &frames,
            synthesis: &[],
            vault_root: vault.path(),
            exported_at_ms: 0,
        })
        .unwrap();
        assert_eq!(outcome.copied_images, 1);
        let markdown = fs::read_to_string(&outcome.markdown_path).unwrap();
        assert!(markdown.contains("](shots/frame.webp)"));
        let bytes = fs::read(Path::new(&outcome.folder).join("shots/frame.webp")).unwrap();
        assert_eq!(&bytes[8..12], b"WEBP");
    }

    #[test]
    fn folder_names_are_stable_and_sanitized() {
        let meeting = meeting();
        let folder = meeting_folder(Path::new("/vault"), &meeting);
        assert_eq!(
            folder,
            Path::new("/vault/meetings/2025-11-14-design-review-q4-0190f3a1")
        );
    }

    #[test]
    fn durations_are_human_readable() {
        assert_eq!(format_duration(0), "00:00");
        assert_eq!(format_duration(35_000), "00:35");
        assert_eq!(format_duration(3_723_000), "01:02:03");
        assert_eq!(format_duration(-5), "00:00");
    }

    #[test]
    fn yaml_strings_are_escaped() {
        assert_eq!(
            yaml_string("a \"quote\"\nline"),
            "\"a \\\"quote\\\"\\nline\""
        );
    }

    #[test]
    fn markdown_table_cells_escape_pipes() {
        assert_eq!(table_cell("a | b\nc"), "a \\| b c");
    }
}
