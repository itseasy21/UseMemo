use std::path::Path;
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{FromRow, QueryBuilder, Sqlite, SqlitePool};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::synthesis::types::SynthesisItemDraft;

pub const DEFAULT_TITLE: &str = "Untitled memo";
pub const STATUS_RECORDING: &str = "recording";
pub const STATUS_PROCESSING: &str = "processing";
pub const STATUS_COMPLETED: &str = "completed";

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub duration_ms: i64,
    pub audio_file_path: Option<String>,
    pub system_audio_file_path: Option<String>,
    pub system_audio_started_at_ms: i64,
    pub diarization_enabled: bool,
    pub screenshot_interval_sec: i64,
    pub asr_model_id: String,
    pub slm_model_id: String,
    pub manual_notes_raw_md: String,
    pub folder_id: Option<String>,
    pub is_starred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct NoteBlock {
    pub id: String,
    pub meeting_id: String,
    pub line_index: i64,
    pub block_type: String,
    pub content_md: String,
    pub recording_offset_ms: Option<i64>,
    pub linked_screenshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Speaker {
    pub id: String,
    pub display_name: String,
    pub color_hex: String,
    #[serde(skip_serializing)]
    pub voiceprint_centroid: Option<Vec<u8>>,
    pub is_local_user: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub meeting_id: String,
    pub seq_no: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_id: Option<String>,
    pub speaker_label: String,
    pub audio_channel: String,
    pub text: String,
    pub is_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub id: String,
    pub meeting_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub file_path: String,
    pub width: i64,
    pub height: i64,
    pub dhash: String,
    pub capture_trigger: String,
    pub ocr_extracted_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisItem {
    pub id: String,
    pub meeting_id: String,
    pub item_type: String,
    pub sort_order: i64,
    pub content: String,
    pub rationale: Option<String>,
    pub owner: Option<String>,
    pub deadline: Option<String>,
    pub is_completed: bool,
    pub is_user_edited: bool,
    pub evidence_refs_json: String,
}

impl SynthesisItem {
    pub fn evidence_refs(&self) -> Vec<String> {
        serde_json::from_str(&self.evidence_refs_json).unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMeetingInput {
    #[serde(default)]
    pub title: Option<String>,
    pub screenshot_interval_sec: Option<i64>,
    pub asr_model_id: Option<String>,
    pub slm_model_id: Option<String>,
    pub folder_id: Option<String>,
    /// Split loopback speech into `Speaker N` labels after the take. Defaults
    /// to on; the recognizer still runs either way.
    pub diarization: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNoteBlock {
    pub line_index: i64,
    #[serde(default = "default_block_type")]
    pub block_type: String,
    pub content_md: String,
    pub recording_offset_ms: Option<i64>,
    pub linked_screenshot_id: Option<String>,
}

fn default_block_type() -> String {
    "paragraph".into()
}

#[derive(Debug, Clone)]
pub struct NewTranscriptSegment {
    pub seq_no: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_label: String,
    pub audio_channel: String,
    pub text: String,
    pub is_confirmed: bool,
}

#[derive(Debug, Clone)]
pub struct NewScreenshot {
    pub start_ms: i64,
    pub end_ms: i64,
    pub file_path: String,
    pub width: i64,
    pub height: i64,
    pub dhash: String,
    pub capture_trigger: String,
    pub ocr_extracted_text: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    pub folder_id: Option<String>,
    pub meeting_id: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub meeting_id: String,
    pub title: String,
    pub snippet: String,
    pub rank: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisItemPatch {
    pub content: Option<String>,
    pub rationale: Option<String>,
    pub owner: Option<String>,
    pub deadline: Option<String>,
    pub is_completed: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    pub async fn connect(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        let database = Self { pool };
        database.migrate().await?;
        Ok(database)
    }

    pub async fn in_memory() -> AppResult<Self> {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let database = Self { pool };
        database.migrate().await?;
        Ok(database)
    }

    pub async fn migrate(&self) -> AppResult<()> {
        sqlx::migrate!("./migrations").run(&self.pool).await?;
        Ok(())
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn create_meeting(&self, input: CreateMeetingInput) -> AppResult<Meeting> {
        let now = Utc::now().timestamp_millis();
        let id = Uuid::now_v7().to_string();
        let title = input
            .title
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| format!("Memo {}", chrono::Local::now().format("%b %-d, %H:%M")));
        let interval = input.screenshot_interval_sec.unwrap_or(10);
        if interval != 0 && !(5..=3600).contains(&interval) {
            return Err(AppError::Invalid(
                "screenshotIntervalSec must be 0 (manual) or between 5 and 3600".into(),
            ));
        }
        let asr_model_id = input.asr_model_id.unwrap_or_else(|| "whisper-small".into());
        let slm_model_id = input
            .slm_model_id
            .unwrap_or_else(|| "gemma-4-e2b-it".into());

        sqlx::query(
            r#"
            INSERT INTO meetings (
                id, title, status, created_at, updated_at, duration_ms, screenshot_interval_sec,
                asr_model_id, slm_model_id, manual_notes_raw_md, folder_id, is_starred,
                diarization_enabled
            ) VALUES (?1, ?2, ?3, ?4, ?4, 0, ?5, ?6, ?7, '', ?8, 0, ?9)
            "#,
        )
        .bind(&id)
        .bind(&title)
        .bind(STATUS_RECORDING)
        .bind(now)
        .bind(interval)
        .bind(&asr_model_id)
        .bind(&slm_model_id)
        .bind(&input.folder_id)
        .bind(input.diarization.unwrap_or(true))
        .execute(&self.pool)
        .await?;

        self.get_meeting(&id).await
    }

    pub async fn get_meeting(&self, id: &str) -> AppResult<Meeting> {
        sqlx::query_as::<_, Meeting>("SELECT * FROM meetings WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::not_found(format!("meeting {id}")))
    }

    pub async fn list_meetings(&self) -> AppResult<Vec<Meeting>> {
        Ok(
            sqlx::query_as::<_, Meeting>("SELECT * FROM meetings ORDER BY created_at DESC")
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub async fn set_meeting_status(&self, id: &str, status: &str) -> AppResult<()> {
        if ![STATUS_RECORDING, STATUS_PROCESSING, STATUS_COMPLETED].contains(&status) {
            return Err(AppError::Invalid(format!(
                "unknown meeting status: {status}"
            )));
        }
        let updated = Utc::now().timestamp_millis();
        let result = sqlx::query("UPDATE meetings SET status = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(status)
            .bind(updated)
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!("meeting {id}")));
        }
        Ok(())
    }

    pub async fn finish_meeting(&self, id: &str, duration_ms: i64) -> AppResult<Meeting> {
        let updated = Utc::now().timestamp_millis();
        let result = sqlx::query(
            "UPDATE meetings SET status = ?1, duration_ms = ?2, updated_at = ?3 WHERE id = ?4",
        )
        .bind(STATUS_COMPLETED)
        .bind(duration_ms.max(0))
        .bind(updated)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!("meeting {id}")));
        }
        self.get_meeting(id).await
    }

    pub async fn set_meeting_starred(&self, id: &str, starred: bool) -> AppResult<()> {
        sqlx::query("UPDATE meetings SET is_starred = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(starred)
            .bind(Utc::now().timestamp_millis())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_audio_file_path(&self, id: &str, path: &str) -> AppResult<()> {
        self.set_audio_file_paths(id, Some(path), None, 0).await
    }

    /// Persist the two independent capture archives in one statement.
    ///
    /// `system` is `None` both when loopback was not requested and when it was
    /// requested but produced nothing, so the vault never points at a file that
    /// is not there.
    pub async fn set_audio_file_paths(
        &self,
        id: &str,
        microphone: Option<&str>,
        system: Option<&str>,
        system_started_at_ms: i64,
    ) -> AppResult<()> {
        sqlx::query(
            "UPDATE meetings SET audio_file_path = ?1, system_audio_file_path = ?2, \
             system_audio_started_at_ms = ?3, updated_at = ?4 WHERE id = ?5",
        )
        .bind(microphone)
        .bind(system)
        .bind(system_started_at_ms.max(0))
        .bind(Utc::now().timestamp_millis())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_screenshot_interval(&self, id: &str, interval_sec: i64) -> AppResult<()> {
        if interval_sec != 0 && !(5..=3600).contains(&interval_sec) {
            return Err(AppError::Invalid(
                "screenshotIntervalSec must be 0 (manual) or between 5 and 3600".into(),
            ));
        }
        sqlx::query(
            "UPDATE meetings SET screenshot_interval_sec = ?1, updated_at = ?2 WHERE id = ?3",
        )
        .bind(interval_sec)
        .bind(Utc::now().timestamp_millis())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn save_note_blocks(
        &self,
        meeting_id: &str,
        raw_md: &str,
        blocks: Vec<NewNoteBlock>,
    ) -> AppResult<Vec<NoteBlock>> {
        self.get_meeting(meeting_id).await?;
        let mut seen = std::collections::BTreeSet::new();
        for block in &blocks {
            if block.line_index < 1 {
                return Err(AppError::Invalid("note lineIndex must be >= 1".into()));
            }
            if !seen.insert(block.line_index) {
                return Err(AppError::Invalid(format!(
                    "duplicate note lineIndex {}",
                    block.line_index
                )));
            }
            if !["paragraph", "decision", "todo", "heading", "bookmark"]
                .contains(&block.block_type.as_str())
            {
                return Err(AppError::Invalid(format!(
                    "unknown note blockType {}",
                    block.block_type
                )));
            }
        }

        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM note_blocks WHERE meeting_id = ?1")
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;
        for block in blocks {
            sqlx::query(
                r#"
                INSERT INTO note_blocks (
                    id, meeting_id, line_index, block_type, content_md, recording_offset_ms, linked_screenshot_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                "#,
            )
            .bind(Uuid::now_v7().to_string())
            .bind(meeting_id)
            .bind(block.line_index)
            .bind(&block.block_type)
            .bind(&block.content_md)
            .bind(block.recording_offset_ms)
            .bind(&block.linked_screenshot_id)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query("UPDATE meetings SET manual_notes_raw_md = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(raw_md)
            .bind(Utc::now().timestamp_millis())
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.list_note_blocks(meeting_id).await
    }

    pub async fn list_note_blocks(&self, meeting_id: &str) -> AppResult<Vec<NoteBlock>> {
        Ok(sqlx::query_as::<_, NoteBlock>(
            "SELECT * FROM note_blocks WHERE meeting_id = ?1 ORDER BY line_index ASC",
        )
        .bind(meeting_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn insert_transcript_segment(
        &self,
        meeting_id: &str,
        segment: NewTranscriptSegment,
    ) -> AppResult<TranscriptSegment> {
        self.get_meeting(meeting_id).await?;
        if !["mic", "system"].contains(&segment.audio_channel.as_str()) {
            return Err(AppError::Invalid(
                "audioChannel must be 'mic' or 'system'".into(),
            ));
        }
        let id = Uuid::now_v7().to_string();
        // `You` is the only stable identity the channel layout can prove.
        // Generic labels stay per-meeting so two different "Speaker 1"s do not
        // share a global voiceprint row.
        let speaker_id = if segment.speaker_label.eq_ignore_ascii_case("You") {
            Some(self.upsert_speaker("You", true).await?.id)
        } else {
            None
        };
        sqlx::query(
            r#"
            INSERT INTO transcript_segments (
                id, meeting_id, seq_no, start_ms, end_ms, speaker_id, speaker_label,
                audio_channel, text, is_confirmed
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(segment.seq_no)
        .bind(segment.start_ms)
        .bind(segment.end_ms)
        .bind(&speaker_id)
        .bind(&segment.speaker_label)
        .bind(&segment.audio_channel)
        .bind(&segment.text)
        .bind(segment.is_confirmed)
        .execute(&self.pool)
        .await?;
        Ok(sqlx::query_as::<_, TranscriptSegment>(
            "SELECT * FROM transcript_segments WHERE id = ?1",
        )
        .bind(&id)
        .fetch_one(&self.pool)
        .await?)
    }

    /// Atomically replace every transcript segment for a meeting.
    ///
    /// Recognition can fail mid-meeting. Deleting first and inserting as we go
    /// would destroy the previous good transcript and leave a half-written one;
    /// a transaction keeps the old rows until the whole run succeeds.
    pub async fn replace_transcript(
        &self,
        meeting_id: &str,
        segments: Vec<NewTranscriptSegment>,
    ) -> AppResult<Vec<TranscriptSegment>> {
        self.get_meeting(meeting_id).await?;
        for segment in &segments {
            if !["mic", "system"].contains(&segment.audio_channel.as_str()) {
                return Err(AppError::Invalid(
                    "audioChannel must be 'mic' or 'system'".into(),
                ));
            }
        }

        let needs_you = segments
            .iter()
            .any(|segment| segment.speaker_label.eq_ignore_ascii_case("You"));
        let you_id = if needs_you {
            Some(self.upsert_speaker("You", true).await?.id)
        } else {
            None
        };

        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM transcript_segments WHERE meeting_id = ?1")
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;

        let mut stored = Vec::with_capacity(segments.len());
        for segment in segments {
            let id = Uuid::now_v7().to_string();
            let speaker_id = if segment.speaker_label.eq_ignore_ascii_case("You") {
                you_id.clone()
            } else {
                None
            };
            sqlx::query(
                r#"
                INSERT INTO transcript_segments (
                    id, meeting_id, seq_no, start_ms, end_ms, speaker_id, speaker_label,
                    audio_channel, text, is_confirmed
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
            )
            .bind(&id)
            .bind(meeting_id)
            .bind(segment.seq_no)
            .bind(segment.start_ms)
            .bind(segment.end_ms)
            .bind(&speaker_id)
            .bind(&segment.speaker_label)
            .bind(&segment.audio_channel)
            .bind(&segment.text)
            .bind(segment.is_confirmed)
            .execute(&mut *tx)
            .await?;
            stored.push(TranscriptSegment {
                id,
                meeting_id: meeting_id.to_string(),
                seq_no: segment.seq_no,
                start_ms: segment.start_ms,
                end_ms: segment.end_ms,
                speaker_id,
                speaker_label: segment.speaker_label,
                audio_channel: segment.audio_channel,
                text: segment.text,
                is_confirmed: segment.is_confirmed,
            });
        }
        tx.commit().await?;
        Ok(stored)
    }

    /// Remove every segment for a meeting. Used before a re-transcription so a
    /// failed run cannot leave a mix of old and new text.
    pub async fn clear_transcript(&self, meeting_id: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM transcript_segments WHERE meeting_id = ?1")
            .bind(meeting_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_transcript(&self, meeting_id: &str) -> AppResult<Vec<TranscriptSegment>> {
        Ok(sqlx::query_as::<_, TranscriptSegment>(
            "SELECT * FROM transcript_segments WHERE meeting_id = ?1 ORDER BY seq_no ASC",
        )
        .bind(meeting_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn list_speakers(&self) -> AppResult<Vec<Speaker>> {
        Ok(sqlx::query_as::<_, Speaker>(
            "SELECT * FROM speakers ORDER BY display_name COLLATE NOCASE",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn upsert_speaker(
        &self,
        display_name: &str,
        is_local_user: bool,
    ) -> AppResult<Speaker> {
        let name = display_name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("speaker display name is empty".into()));
        }
        if let Some(mut existing) = sqlx::query_as::<_, Speaker>(
            "SELECT * FROM speakers WHERE display_name = ?1 COLLATE NOCASE",
        )
        .bind(name)
        .fetch_optional(&self.pool)
        .await?
        {
            if is_local_user && !existing.is_local_user {
                sqlx::query("UPDATE speakers SET is_local_user = 1 WHERE id = ?1")
                    .bind(&existing.id)
                    .execute(&self.pool)
                    .await?;
                existing.is_local_user = true;
            }
            return Ok(existing);
        }
        let id = Uuid::now_v7().to_string();
        let color = speaker_color(name);
        sqlx::query(
            "INSERT INTO speakers (id, display_name, color_hex, voiceprint_centroid, is_local_user, created_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
        )
        .bind(&id)
        .bind(name)
        .bind(color)
        .bind(is_local_user)
        .bind(Utc::now().timestamp_millis())
        .execute(&self.pool)
        .await?;
        Ok(
            sqlx::query_as::<_, Speaker>("SELECT * FROM speakers WHERE id = ?1")
                .bind(&id)
                .fetch_one(&self.pool)
                .await?,
        )
    }

    pub async fn rename_speaker(
        &self,
        meeting_id: &str,
        old_label: &str,
        new_name: &str,
        _save_voiceprint: bool,
    ) -> AppResult<Speaker> {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err(AppError::Invalid("new speaker name is empty".into()));
        }
        self.get_meeting(meeting_id).await?;
        let speaker = self.upsert_speaker(new_name, false).await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE transcript_segments SET speaker_id = ?1, speaker_label = ?2
             WHERE meeting_id = ?3 AND (speaker_label = ?4 OR speaker_id = ?1)",
        )
        .bind(&speaker.id)
        .bind(new_name)
        .bind(meeting_id)
        .bind(old_label)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(speaker)
    }

    pub async fn insert_screenshot(
        &self,
        meeting_id: &str,
        shot: NewScreenshot,
    ) -> AppResult<Screenshot> {
        self.get_meeting(meeting_id).await?;
        if !["interval", "manual"].contains(&shot.capture_trigger.as_str()) {
            return Err(AppError::Invalid(
                "captureTrigger must be 'interval' or 'manual'".into(),
            ));
        }
        let id = Uuid::now_v7().to_string();
        sqlx::query(
            r#"
            INSERT INTO screenshots (
                id, meeting_id, start_ms, end_ms, file_path, width, height, dhash,
                capture_trigger, ocr_extracted_text
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(shot.start_ms)
        .bind(shot.end_ms)
        .bind(&shot.file_path)
        .bind(shot.width)
        .bind(shot.height)
        .bind(&shot.dhash)
        .bind(&shot.capture_trigger)
        .bind(&shot.ocr_extracted_text)
        .execute(&self.pool)
        .await?;
        self.get_screenshot(&id).await
    }

    pub async fn get_screenshot(&self, id: &str) -> AppResult<Screenshot> {
        sqlx::query_as::<_, Screenshot>("SELECT * FROM screenshots WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::not_found(format!("screenshot {id}")))
    }

    pub async fn list_screenshots(&self, meeting_id: &str) -> AppResult<Vec<Screenshot>> {
        Ok(sqlx::query_as::<_, Screenshot>(
            "SELECT * FROM screenshots WHERE meeting_id = ?1 ORDER BY start_ms ASC",
        )
        .bind(meeting_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn extend_screenshot(&self, id: &str, end_ms: i64) -> AppResult<()> {
        sqlx::query("UPDATE screenshots SET end_ms = MAX(end_ms, ?1) WHERE id = ?2")
            .bind(end_ms)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn update_screenshot_ocr(&self, id: &str, text: &str) -> AppResult<()> {
        let result = sqlx::query("UPDATE screenshots SET ocr_extracted_text = ?1 WHERE id = ?2")
            .bind(text)
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!("screenshot {id}")));
        }
        Ok(())
    }

    pub async fn replace_synthesis_items(
        &self,
        meeting_id: &str,
        items: Vec<SynthesisItemDraft>,
    ) -> AppResult<Vec<SynthesisItem>> {
        self.get_meeting(meeting_id).await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM synthesis_items WHERE meeting_id = ?1")
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;
        for item in items {
            sqlx::query(
                r#"
                INSERT INTO synthesis_items (
                    id, meeting_id, item_type, sort_order, content, rationale, owner, deadline,
                    is_completed, is_user_edited, evidence_refs_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                "#,
            )
            .bind(Uuid::now_v7().to_string())
            .bind(meeting_id)
            .bind(&item.item_type)
            .bind(item.sort_order)
            .bind(&item.content)
            .bind(&item.rationale)
            .bind(&item.owner)
            .bind(&item.deadline)
            .bind(item.is_completed)
            .bind(item.is_user_edited)
            .bind(serde_json::to_string(&item.evidence_refs)?)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.list_synthesis_items(meeting_id).await
    }

    pub async fn list_synthesis_items(&self, meeting_id: &str) -> AppResult<Vec<SynthesisItem>> {
        Ok(sqlx::query_as::<_, SynthesisItem>(
            "SELECT * FROM synthesis_items WHERE meeting_id = ?1 ORDER BY item_type, sort_order ASC",
        )
        .bind(meeting_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn update_synthesis_item(
        &self,
        item_id: &str,
        patch: SynthesisItemPatch,
    ) -> AppResult<SynthesisItem> {
        let result = sqlx::query(
            r#"
            UPDATE synthesis_items SET
                content = COALESCE(?1, content),
                rationale = COALESCE(?2, rationale),
                owner = COALESCE(?3, owner),
                deadline = COALESCE(?4, deadline),
                is_completed = COALESCE(?5, is_completed),
                is_user_edited = 1
            WHERE id = ?6
            "#,
        )
        .bind(patch.content)
        .bind(patch.rationale)
        .bind(patch.owner)
        .bind(patch.deadline)
        .bind(patch.is_completed)
        .bind(item_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!("synthesis item {item_id}")));
        }
        Ok(
            sqlx::query_as::<_, SynthesisItem>("SELECT * FROM synthesis_items WHERE id = ?1")
                .bind(item_id)
                .fetch_one(&self.pool)
                .await?,
        )
    }

    pub async fn create_folder(&self, name: &str, parent_id: Option<&str>) -> AppResult<Folder> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("folder name is empty".into()));
        }
        let folder = Folder {
            id: Uuid::now_v7().to_string(),
            name: name.to_string(),
            parent_id: parent_id.map(ToOwned::to_owned),
            created_at: Utc::now().timestamp_millis(),
        };
        sqlx::query(
            "INSERT INTO folders (id, name, parent_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(&folder.id)
        .bind(&folder.name)
        .bind(&folder.parent_id)
        .bind(folder.created_at)
        .execute(&self.pool)
        .await?;
        Ok(folder)
    }

    pub async fn list_folders(&self) -> AppResult<Vec<Folder>> {
        Ok(sqlx::query_as::<_, Folder>(
            "SELECT id, name, parent_id, created_at FROM folders ORDER BY name COLLATE NOCASE",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn search(
        &self,
        raw_query: &str,
        filters: SearchFilters,
    ) -> AppResult<Vec<SearchHit>> {
        let Some(fts_query) = build_fts_query(raw_query) else {
            return Ok(Vec::new());
        };
        let limit = filters.limit.unwrap_or(25).clamp(1, 100) as i64;
        let mut builder = QueryBuilder::<Sqlite>::new(
            r#"
            SELECT
                f.meeting_id AS meeting_id,
                f.title AS title,
                snippet(meetings_search_fts, 2, '<mark>', '</mark>', '…', 24) AS notes_snippet,
                snippet(meetings_search_fts, 3, '<mark>', '</mark>', '…', 24) AS transcript_snippet,
                snippet(meetings_search_fts, 4, '<mark>', '</mark>', '…', 24) AS synthesis_snippet,
                snippet(meetings_search_fts, 5, '<mark>', '</mark>', '…', 24) AS slide_snippet,
                bm25(meetings_search_fts, 0.0, 12.0, 8.0, 2.0, 5.0, 6.0, 3.0) AS rank
            FROM meetings_search_fts f
            JOIN meetings m ON m.id = f.meeting_id
            WHERE meetings_search_fts MATCH
            "#,
        );
        builder.push_bind(fts_query);
        if let Some(meeting_id) = filters.meeting_id {
            builder.push(" AND f.meeting_id = ").push_bind(meeting_id);
        }
        if let Some(folder_id) = filters.folder_id {
            builder.push(" AND m.folder_id = ").push_bind(folder_id);
        }
        builder.push(" ORDER BY rank ASC LIMIT ").push_bind(limit);

        #[derive(FromRow)]
        struct SearchRow {
            meeting_id: String,
            title: String,
            notes_snippet: Option<String>,
            transcript_snippet: Option<String>,
            synthesis_snippet: Option<String>,
            slide_snippet: Option<String>,
            rank: f64,
        }

        let rows = builder
            .build_query_as::<SearchRow>()
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let candidates = [
                    row.transcript_snippet,
                    row.notes_snippet,
                    row.synthesis_snippet,
                    row.slide_snippet,
                ];
                let snippet = candidates
                    .iter()
                    .flatten()
                    .find(|candidate| candidate.contains("<mark>"))
                    .or_else(|| {
                        candidates
                            .iter()
                            .flatten()
                            .find(|candidate| !candidate.is_empty())
                    })
                    .cloned()
                    .unwrap_or_default();
                SearchHit {
                    meeting_id: row.meeting_id,
                    title: row.title,
                    snippet,
                    rank: row.rank,
                }
            })
            .collect())
    }

    pub async fn rebuild_search_index(&self) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM meetings_search_fts")
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"
            INSERT INTO meetings_search_fts
            SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
            FROM meeting_search_documents
            "#,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete_meeting(&self, meeting_id: &str) -> AppResult<()> {
        let result = sqlx::query("DELETE FROM meetings WHERE id = ?1")
            .bind(meeting_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!("meeting {meeting_id}")));
        }
        Ok(())
    }
}

pub fn build_fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split_whitespace()
        .filter_map(|term| {
            let cleaned: String = term
                .chars()
                .filter(|c| c.is_alphanumeric() || matches!(c, '_' | '-'))
                .collect();
            if cleaned.is_empty() {
                None
            } else {
                Some(format!("\"{}\"*", cleaned.replace('"', "")))
            }
        })
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" AND "))
    }
}

fn speaker_color(name: &str) -> String {
    const PALETTE: &[&str] = &[
        "#34d3a0", "#6aa8f8", "#f5a524", "#f06a8a", "#b083f0", "#58c7d8", "#e0c15a", "#8bc34a",
    ];
    let hash = name.bytes().fold(0u64, |acc, byte| {
        acc.wrapping_mul(131).wrapping_add(byte as u64)
    });
    PALETTE[(hash as usize) % PALETTE.len()].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthesis::types::SynthesisItemDraft;

    async fn db() -> Database {
        Database::in_memory().await.unwrap()
    }

    fn note(index: i64, text: &str) -> NewNoteBlock {
        NewNoteBlock {
            line_index: index,
            block_type: "paragraph".into(),
            content_md: text.into(),
            recording_offset_ms: Some(index * 1000),
            linked_screenshot_id: None,
        }
    }

    fn transcript_seg(seq_no: i64, text: &str) -> NewTranscriptSegment {
        NewTranscriptSegment {
            seq_no,
            start_ms: seq_no * 1_000,
            end_ms: seq_no * 1_000 + 800,
            speaker_label: "You".into(),
            audio_channel: "mic".into(),
            text: text.into(),
            is_confirmed: true,
        }
    }

    #[tokio::test]
    async fn replace_transcript_is_atomic_and_ordered() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput {
                title: Some("Transcript Swap".into()),
                screenshot_interval_sec: Some(10),
                asr_model_id: Some("whisper-small".into()),
                slm_model_id: Some("gemma-e4b".into()),
                folder_id: None,
                diarization: None,
            })
            .await
            .unwrap();
        db.insert_transcript_segment(&meeting.id, transcript_seg(1, "Original line."))
            .await
            .unwrap();

        // A rejected batch must not touch the existing transcript.
        let mut invalid = transcript_seg(2, "Invalid line.");
        invalid.audio_channel = "loopback".into();
        assert!(db
            .replace_transcript(&meeting.id, vec![invalid])
            .await
            .is_err());
        let rows = db.list_transcript(&meeting.id).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "Original line.");

        let stored = db
            .replace_transcript(
                &meeting.id,
                vec![transcript_seg(1, "First."), transcript_seg(2, "Second.")],
            )
            .await
            .unwrap();
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].id.len(), 36);

        let rows = db.list_transcript(&meeting.id).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].text, "First.");
        assert_eq!(rows[1].seq_no, 2);
        assert_eq!(rows[1].text, "Second.");
    }

    #[tokio::test]
    async fn migrations_create_core_tables_and_fts5() {
        let db = db().await;
        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(db.pool())
        .await
        .unwrap();
        let names: Vec<_> = tables.into_iter().map(|(name,)| name).collect();
        for expected in [
            "meetings",
            "note_blocks",
            "speakers",
            "transcript_segments",
            "screenshots",
            "synthesis_items",
            "meetings_search_fts",
        ] {
            assert!(
                names.iter().any(|name| name == expected),
                "missing table {expected}"
            );
        }
    }

    #[tokio::test]
    async fn recording_paths_store_microphone_and_system_archives() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput {
                title: Some("Two streams".into()),
                screenshot_interval_sec: Some(10),
                asr_model_id: Some("whisper-small".into()),
                slm_model_id: Some("gemma-e4b".into()),
                folder_id: None,
                diarization: None,
            })
            .await
            .unwrap();
        assert_eq!(meeting.system_audio_file_path, None);

        db.set_audio_file_paths(
            &meeting.id,
            Some("/vault/m/audio.wav"),
            Some("/vault/m/audio-system.wav"),
            420,
        )
        .await
        .unwrap();
        let stored = db.get_meeting(&meeting.id).await.unwrap();
        assert_eq!(
            stored.audio_file_path.as_deref(),
            Some("/vault/m/audio.wav")
        );
        assert_eq!(
            stored.system_audio_file_path.as_deref(),
            Some("/vault/m/audio-system.wav")
        );
        assert_eq!(stored.system_audio_started_at_ms, 420);

        // A microphone-only retake must clear the stale system path, not leave
        // the transcript pointing at an old loopback file.
        db.set_audio_file_paths(&meeting.id, Some("/vault/m/audio.wav"), None, 0)
            .await
            .unwrap();
        let stored = db.get_meeting(&meeting.id).await.unwrap();
        assert_eq!(stored.system_audio_file_path, None);
        assert_eq!(stored.system_audio_started_at_ms, 0);
    }

    #[tokio::test]
    async fn meeting_lifecycle_and_note_blocks_roundtrip() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput {
                title: Some("Q3 Launch".into()),
                screenshot_interval_sec: Some(10),
                asr_model_id: Some("parakeet".into()),
                slm_model_id: Some("gemma-e4b".into()),
                folder_id: None,
                diarization: None,
            })
            .await
            .unwrap();
        assert_eq!(meeting.status, STATUS_RECORDING);
        assert_eq!(meeting.screenshot_interval_sec, 10);

        let blocks = db
            .save_note_blocks(
                &meeting.id,
                "[N-L1] Client wants Q3 launch moved to October 15.",
                vec![note(1, "Client wants Q3 launch moved to October 15.")],
            )
            .await
            .unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].line_index, 1);

        let replaced = db
            .save_note_blocks(
                &meeting.id,
                "DECISION: PostgreSQL for billing.",
                vec![note(1, "DECISION: PostgreSQL for billing.")],
            )
            .await
            .unwrap();
        assert_eq!(replaced.len(), 1);
        assert_eq!(replaced[0].content_md, "DECISION: PostgreSQL for billing.");

        let finished = db.finish_meeting(&meeting.id, 35_000).await.unwrap();
        assert_eq!(finished.status, STATUS_COMPLETED);
        assert_eq!(finished.duration_ms, 35_000);
        assert!(finished.manual_notes_raw_md.contains("PostgreSQL"));
    }

    #[tokio::test]
    async fn search_finds_notes_transcript_slides_and_synthesis_with_highlights() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput {
                title: Some("Billing architecture".into()),
                screenshot_interval_sec: Some(10),
                asr_model_id: None,
                slm_model_id: None,
                folder_id: None,
                diarization: None,
            })
            .await
            .unwrap();

        db.save_note_blocks(
            &meeting.id,
            "DECISION: Use PostgreSQL instead of MongoDB for billing.",
            vec![note(
                1,
                "DECISION: Use PostgreSQL instead of MongoDB for billing.",
            )],
        )
        .await
        .unwrap();

        db.insert_transcript_segment(
            &meeting.id,
            NewTranscriptSegment {
                seq_no: 1,
                start_ms: 245_000,
                end_ms: 265_000,
                speaker_label: "You".into(),
                audio_channel: "mic".into(),
                text: "Let's lock in PostgreSQL for the billing microservice.".into(),
                is_confirmed: true,
            },
        )
        .await
        .unwrap();

        db.insert_screenshot(
            &meeting.id,
            NewScreenshot {
                start_ms: 250_000,
                end_ms: 260_000,
                file_path: "/tmp/shot.webp".into(),
                width: 1920,
                height: 1080,
                dhash: "0000000000000000".into(),
                capture_trigger: "interval".into(),
                ocr_extracted_text: Some("Billing Architecture v2 - PostgreSQL + Redis".into()),
            },
        )
        .await
        .unwrap();

        db.replace_synthesis_items(
            &meeting.id,
            vec![SynthesisItemDraft {
                item_type: "decision".into(),
                sort_order: 1,
                content: "Adopt PostgreSQL for the billing service.".into(),
                rationale: Some("Operational familiarity.".into()),
                owner: None,
                deadline: None,
                is_completed: false,
                is_user_edited: false,
                evidence_refs: vec!["N-L1".into()],
            }],
        )
        .await
        .unwrap();

        let hits = db
            .search("PostgreSQL", SearchFilters::default())
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].meeting_id, meeting.id);
        assert!(
            hits[0].snippet.contains("<mark>PostgreSQL</mark>"),
            "{}",
            hits[0].snippet
        );
        assert!(hits[0].rank.is_finite());

        let no_hits = db
            .search(
                "MongoDB",
                SearchFilters {
                    meeting_id: Some("nope".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(no_hits.is_empty());
    }

    #[tokio::test]
    async fn fts_queries_are_sanitized() {
        let db = db().await;
        db.create_meeting(CreateMeetingInput::default())
            .await
            .unwrap();
        for query in ["\"", "*", "OR", "NEAR(", "a\"b", "🙂"] {
            let result = db.search(query, SearchFilters::default()).await;
            assert!(result.is_ok(), "query {query:?} failed: {result:?}");
        }
        assert!(build_fts_query("   ").is_none());
        assert_eq!(
            build_fts_query("hello world").unwrap(),
            "\"hello\"* AND \"world\"*"
        );
    }

    #[tokio::test]
    async fn cascading_delete_removes_children_and_search_rows() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput::default())
            .await
            .unwrap();
        db.save_note_blocks(&meeting.id, "secret", vec![note(1, "secret")])
            .await
            .unwrap();
        db.delete_meeting(&meeting.id).await.unwrap();
        assert!(db.get_meeting(&meeting.id).await.is_err());
        assert!(db.list_note_blocks(&meeting.id).await.unwrap().is_empty());
        assert!(db
            .search("secret", SearchFilters::default())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn speaker_rename_updates_transcript_and_search() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput::default())
            .await
            .unwrap();
        let segment = db
            .insert_transcript_segment(
                &meeting.id,
                NewTranscriptSegment {
                    seq_no: 1,
                    start_ms: 0,
                    end_ms: 2000,
                    speaker_label: "Speaker 1".into(),
                    audio_channel: "system".into(),
                    text: "I'll send the revised AWS cost sheet by Wednesday.".into(),
                    is_confirmed: true,
                },
            )
            .await
            .unwrap();
        let speaker = db
            .rename_speaker(&meeting.id, "Speaker 1", "Alex", false)
            .await
            .unwrap();
        assert_eq!(speaker.display_name, "Alex");
        let transcript = db.list_transcript(&meeting.id).await.unwrap();
        assert_eq!(transcript[0].speaker_label, "Alex");
        assert_eq!(transcript[0].id, segment.id);
        let hits = db.search("Alex", SearchFilters::default()).await.unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[tokio::test]
    async fn synthesis_items_roundtrip_and_user_edits_are_flagged() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput::default())
            .await
            .unwrap();
        let items = db
            .replace_synthesis_items(
                &meeting.id,
                vec![
                    SynthesisItemDraft {
                        item_type: "summary".into(),
                        sort_order: 0,
                        content: "The team agreed on a Q3 launch in October.".into(),
                        rationale: None,
                        owner: None,
                        deadline: None,
                        is_completed: false,
                        is_user_edited: false,
                        evidence_refs: vec!["T-00:40".into()],
                    },
                    SynthesisItemDraft {
                        item_type: "action_item".into(),
                        sort_order: 1,
                        content: "Send revised AWS cost sheet.".into(),
                        rationale: None,
                        owner: Some("Alex".into()),
                        deadline: Some("Wednesday".into()),
                        is_completed: false,
                        is_user_edited: false,
                        evidence_refs: vec!["T-09:20".into()],
                    },
                ],
            )
            .await
            .unwrap();
        assert_eq!(items.len(), 2);
        let action = items
            .iter()
            .find(|item| item.item_type == "action_item")
            .unwrap();
        assert_eq!(action.evidence_refs(), vec!["T-09:20"]);

        let updated = db
            .update_synthesis_item(
                &action.id,
                SynthesisItemPatch {
                    is_completed: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(updated.is_completed);
        assert!(updated.is_user_edited);
    }

    #[tokio::test]
    async fn screenshot_ocr_update_refreshes_search() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput::default())
            .await
            .unwrap();
        let shot = db
            .insert_screenshot(
                &meeting.id,
                NewScreenshot {
                    start_ms: 0,
                    end_ms: 1000,
                    file_path: "/tmp/a.webp".into(),
                    width: 100,
                    height: 100,
                    dhash: "0".into(),
                    capture_trigger: "manual".into(),
                    ocr_extracted_text: None,
                },
            )
            .await
            .unwrap();
        db.update_screenshot_ocr(&shot.id, "Roadmap: FedRAMP certification")
            .await
            .unwrap();
        let hits = db
            .search("FedRAMP", SearchFilters::default())
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
    }
}
