use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{FromRow, QueryBuilder, Sqlite, SqliteConnection, SqlitePool};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::brand::BrandPaths;
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

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeetingPatch {
    pub title: Option<String>,
    pub folder_id: Option<String>,
    #[serde(default)]
    pub clear_folder: bool,
    pub diarization_enabled: Option<bool>,
    pub asr_model_id: Option<String>,
    pub slm_model_id: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCounts {
    pub meetings: i64,
    pub transcript_segments: i64,
    pub note_blocks: i64,
    pub screenshots: i64,
    pub synthesis_items: i64,
    pub speakers: i64,
    pub folders: i64,
}

#[derive(Debug, Clone)]
pub struct Database {
    pool: SqlitePool,
    /// Serializes multi-statement SQLite writers in async space so concurrent
    /// screenshot capture, live note autosave, and transcription never collide
    /// on deferred read->write promotion (`SQLITE_BUSY_SNAPSHOT`).
    write_lock: Arc<Mutex<()>>,
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
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        let database = Self {
            pool,
            write_lock: Arc::new(Mutex::new(())),
        };
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
        let database = Self {
            pool,
            write_lock: Arc::new(Mutex::new(())),
        };
        database.migrate().await?;
        Ok(database)
    }

    pub async fn migrate(&self) -> AppResult<()> {
        let _guard = self.write_lock.lock().await;
        sqlx::migrate!("./migrations").run(&self.pool).await?;
        Ok(())
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Re-index a single meeting's FTS5 document in O(1) lookup time via `meeting_fts_map`.
    async fn refresh_meeting_fts(conn: &mut SqliteConnection, meeting_id: &str) -> AppResult<()> {
        let existing_rowid: Option<(i64,)> =
            sqlx::query_as("SELECT fts_rowid FROM meeting_fts_map WHERE meeting_id = ?1")
                .bind(meeting_id)
                .fetch_optional(&mut *conn)
                .await?;
        if let Some((rowid,)) = existing_rowid {
            sqlx::query("DELETE FROM meetings_search_fts WHERE rowid = ?1")
                .bind(rowid)
                .execute(&mut *conn)
                .await?;
            sqlx::query("DELETE FROM meeting_fts_map WHERE meeting_id = ?1")
                .bind(meeting_id)
                .execute(&mut *conn)
                .await?;
        }

        let inserted = sqlx::query(
            r#"
            INSERT INTO meetings_search_fts (
                meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
            )
            SELECT
                meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
            FROM meeting_search_documents
            WHERE meeting_id = ?1
            "#,
        )
        .bind(meeting_id)
        .execute(&mut *conn)
        .await?;

        if inserted.rows_affected() > 0 {
            let new_rowid = inserted.last_insert_rowid();
            sqlx::query(
                "INSERT OR REPLACE INTO meeting_fts_map (meeting_id, fts_rowid) VALUES (?1, ?2)",
            )
            .bind(meeting_id)
            .bind(new_rowid)
            .execute(&mut *conn)
            .await?;
        }
        Ok(())
    }

    /// Inspect any meeting left in `'recording'` or `'processing'` after an app
    /// quit, crash, or power loss: salvage unfinalized WAV headers on disk,
    /// restore missing audio paths if `audio.wav` exists, compute sample-accurate
    /// duration, and transition the meeting to `'completed'`.
    pub async fn recover_interrupted_meetings(&self, paths: &BrandPaths) -> AppResult<usize> {
        let interrupted: Vec<Meeting> =
            sqlx::query_as::<_, Meeting>("SELECT * FROM meetings WHERE status IN (?1, ?2)")
                .bind(STATUS_RECORDING)
                .bind(STATUS_PROCESSING)
                .fetch_all(&self.pool)
                .await?;

        if interrupted.is_empty() {
            return Ok(0);
        }

        let mut recovered = 0usize;
        for meeting in interrupted {
            let media_dir = paths.meeting_media_dir(&meeting.id);
            let candidate_mic = meeting
                .audio_file_path
                .clone()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| media_dir.join("audio.wav"));
            let candidate_sys = meeting
                .system_audio_file_path
                .clone()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| media_dir.join("audio-system.wav"));

            let mut max_duration_ms = meeting.duration_ms.max(0);
            let mic_path_opt = if candidate_mic.is_file() {
                if let Ok(meta) = memo_audio_capture::salvage_wav_file(&candidate_mic) {
                    max_duration_ms = max_duration_ms.max(meta.duration_ms);
                    if meta.frames > 0 {
                        Some(candidate_mic.to_string_lossy().into_owned())
                    } else {
                        let _ = std::fs::remove_file(&candidate_mic);
                        None
                    }
                } else {
                    Some(candidate_mic.to_string_lossy().into_owned())
                }
            } else {
                None
            };

            let sys_path_opt = if candidate_sys.is_file() {
                if let Ok(meta) = memo_audio_capture::salvage_wav_file(&candidate_sys) {
                    max_duration_ms = max_duration_ms.max(
                        meeting
                            .system_audio_started_at_ms
                            .saturating_add(meta.duration_ms),
                    );
                    if meta.frames > 0 {
                        Some(candidate_sys.to_string_lossy().into_owned())
                    } else {
                        let _ = std::fs::remove_file(&candidate_sys);
                        None
                    }
                } else {
                    Some(candidate_sys.to_string_lossy().into_owned())
                }
            } else {
                None
            };

            self.set_audio_file_paths(
                &meeting.id,
                mic_path_opt.as_deref(),
                sys_path_opt.as_deref(),
                if sys_path_opt.is_some() {
                    meeting.system_audio_started_at_ms
                } else {
                    0
                },
            )
            .await?;
            self.finish_meeting(&meeting.id, max_duration_ms).await?;
            recovered += 1;
        }

        Ok(recovered)
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
            .unwrap_or_else(|| "qwen2.5-3b-instruct".into());

        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
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
            .execute(&mut *tx)
            .await?;
            Self::refresh_meeting_fts(&mut tx, &id).await?;
            tx.commit().await?;
        }

        self.get_meeting(&id).await
    }

    pub async fn update_meeting(&self, id: &str, patch: UpdateMeetingPatch) -> AppResult<Meeting> {
        let current = self.get_meeting(id).await?;
        let next_title = match patch.title {
            Some(title) => {
                let trimmed = title.trim();
                if trimmed.is_empty() {
                    return Err(AppError::Invalid("meeting title cannot be empty".into()));
                }
                trimmed.to_string()
            }
            None => current.title,
        };
        let next_folder = if patch.clear_folder {
            None
        } else {
            patch.folder_id.or(current.folder_id)
        };
        let next_diarization = patch
            .diarization_enabled
            .unwrap_or(current.diarization_enabled);
        let next_asr = patch.asr_model_id.unwrap_or(current.asr_model_id);
        let next_slm = patch.slm_model_id.unwrap_or(current.slm_model_id);

        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
            sqlx::query(
                r#"
                UPDATE meetings SET
                    title = ?1,
                    folder_id = ?2,
                    diarization_enabled = ?3,
                    asr_model_id = ?4,
                    slm_model_id = ?5,
                    updated_at = ?6
                WHERE id = ?7
                "#,
            )
            .bind(&next_title)
            .bind(&next_folder)
            .bind(next_diarization)
            .bind(&next_asr)
            .bind(&next_slm)
            .bind(Utc::now().timestamp_millis())
            .bind(id)
            .execute(&mut *tx)
            .await?;
            Self::refresh_meeting_fts(&mut tx, id).await?;
            tx.commit().await?;
        }
        self.get_meeting(id).await
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
        let _guard = self.write_lock.lock().await;
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
        {
            let _guard = self.write_lock.lock().await;
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
        }
        self.get_meeting(id).await
    }

    pub async fn set_meeting_starred(&self, id: &str, starred: bool) -> AppResult<()> {
        let _guard = self.write_lock.lock().await;
        let result =
            sqlx::query("UPDATE meetings SET is_starred = ?1, updated_at = ?2 WHERE id = ?3")
                .bind(starred)
                .bind(Utc::now().timestamp_millis())
                .bind(id)
                .execute(&self.pool)
                .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!("meeting {id}")));
        }
        Ok(())
    }

    pub async fn set_audio_file_path(&self, id: &str, path: &str) -> AppResult<()> {
        self.set_audio_file_paths(id, Some(path), None, 0).await
    }

    /// Persist the two independent capture archives in one statement.
    pub async fn set_audio_file_paths(
        &self,
        id: &str,
        microphone: Option<&str>,
        system: Option<&str>,
        system_started_at_ms: i64,
    ) -> AppResult<()> {
        let _guard = self.write_lock.lock().await;
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
        let _guard = self.write_lock.lock().await;
        let result = sqlx::query(
            "UPDATE meetings SET screenshot_interval_sec = ?1, updated_at = ?2 WHERE id = ?3",
        )
        .bind(interval_sec)
        .bind(Utc::now().timestamp_millis())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!("meeting {id}")));
        }
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

        {
            let _guard = self.write_lock.lock().await;
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
            sqlx::query(
                "UPDATE meetings SET manual_notes_raw_md = ?1, updated_at = ?2 WHERE id = ?3",
            )
            .bind(raw_md)
            .bind(Utc::now().timestamp_millis())
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;
            Self::refresh_meeting_fts(&mut tx, meeting_id).await?;
            tx.commit().await?;
        }
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
        let speaker_id = if segment.speaker_label.eq_ignore_ascii_case("You") {
            Some(self.upsert_speaker("You", true).await?.id)
        } else {
            None
        };
        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
            sqlx::query(
                r#"
                INSERT INTO transcript_segments (
                    id, meeting_id, seq_no, start_ms, end_ms, speaker_id, speaker_label,
                    raw_speaker_cluster, audio_channel, text, is_confirmed
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10)
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
            Self::refresh_meeting_fts(&mut tx, meeting_id).await?;
            tx.commit().await?;
        }
        Ok(sqlx::query_as::<_, TranscriptSegment>(
            "SELECT id, meeting_id, seq_no, start_ms, end_ms, speaker_id, speaker_label, audio_channel, text, is_confirmed \
             FROM transcript_segments WHERE id = ?1",
        )
        .bind(&id)
        .fetch_one(&self.pool)
        .await?)
    }

    /// Atomically replace every transcript segment for a meeting in a single
    /// transaction with a single O(1) FTS5 document refresh at commit time.
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
        if needs_you {
            let _ = self.upsert_speaker("You", true).await?;
        }
        let known_speakers: std::collections::HashMap<String, String> = self
            .list_speakers()
            .await?
            .into_iter()
            .map(|sp| (sp.display_name.to_lowercase(), sp.id))
            .collect();

        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM transcript_segments WHERE meeting_id = ?1")
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;

        let mut stored = Vec::with_capacity(segments.len());
        for segment in segments {
            let id = Uuid::now_v7().to_string();
            let speaker_id = known_speakers
                .get(&segment.speaker_label.to_lowercase())
                .cloned();
            sqlx::query(
                r#"
                INSERT INTO transcript_segments (
                    id, meeting_id, seq_no, start_ms, end_ms, speaker_id, speaker_label,
                    raw_speaker_cluster, audio_channel, text, is_confirmed
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10)
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
        Self::refresh_meeting_fts(&mut tx, meeting_id).await?;
        tx.commit().await?;
        Ok(stored)
    }

    pub async fn update_transcript_segment(
        &self,
        segment_id: &str,
        text: Option<&str>,
        speaker_label: Option<&str>,
    ) -> AppResult<TranscriptSegment> {
        let existing: Option<TranscriptSegment> = sqlx::query_as(
            "SELECT id, meeting_id, seq_no, start_ms, end_ms, speaker_id, speaker_label, audio_channel, text, is_confirmed \
             FROM transcript_segments WHERE id = ?1",
        )
        .bind(segment_id)
        .fetch_optional(&self.pool)
        .await?;
        let existing =
            existing.ok_or_else(|| AppError::not_found(format!("segment {segment_id}")))?;

        let next_text = match text {
            Some(t) => {
                let trimmed = t.trim();
                if trimmed.is_empty() {
                    return Err(AppError::Invalid("transcript text cannot be empty".into()));
                }
                trimmed.to_string()
            }
            None => existing.text,
        };
        let next_speaker = match speaker_label {
            Some(label) => {
                let trimmed = label.trim();
                if trimmed.is_empty() {
                    return Err(AppError::Invalid("speaker label cannot be empty".into()));
                }
                trimmed.to_string()
            }
            None => existing.speaker_label,
        };

        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
            sqlx::query(
                "UPDATE transcript_segments SET text = ?1, speaker_label = ?2, is_confirmed = 1 WHERE id = ?3",
            )
            .bind(&next_text)
            .bind(&next_speaker)
            .bind(segment_id)
            .execute(&mut *tx)
            .await?;
            Self::refresh_meeting_fts(&mut tx, &existing.meeting_id).await?;
            tx.commit().await?;
        }

        Ok(sqlx::query_as::<_, TranscriptSegment>(
            "SELECT id, meeting_id, seq_no, start_ms, end_ms, speaker_id, speaker_label, audio_channel, text, is_confirmed \
             FROM transcript_segments WHERE id = ?1",
        )
        .bind(segment_id)
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn clear_transcript(&self, meeting_id: &str) -> AppResult<()> {
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM transcript_segments WHERE meeting_id = ?1")
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;
        Self::refresh_meeting_fts(&mut tx, meeting_id).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_transcript(&self, meeting_id: &str) -> AppResult<Vec<TranscriptSegment>> {
        Ok(sqlx::query_as::<_, TranscriptSegment>(
            "SELECT id, meeting_id, seq_no, start_ms, end_ms, speaker_id, speaker_label, audio_channel, text, is_confirmed \
             FROM transcript_segments WHERE meeting_id = ?1 ORDER BY seq_no ASC",
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
        let _guard = self.write_lock.lock().await;
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
        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
            // Match by raw_speaker_cluster when `old_label` names an original
            // diarization cluster (`Speaker 1`), otherwise match current `speaker_label`
            // without cross-merging distinct raw clusters that previously shared a name.
            sqlx::query(
                r#"
                UPDATE transcript_segments
                SET speaker_id = ?1, speaker_label = ?2
                WHERE meeting_id = ?3
                  AND (raw_speaker_cluster = ?4 OR speaker_label = ?4)
                "#,
            )
            .bind(&speaker.id)
            .bind(new_name)
            .bind(meeting_id)
            .bind(old_label)
            .execute(&mut *tx)
            .await?;
            Self::refresh_meeting_fts(&mut tx, meeting_id).await?;
            tx.commit().await?;
        }
        Ok(speaker)
    }

    /// Persist or blend an acoustic voiceprint centroid (`memo_diarize` L2 float32 bytes)
    /// onto an enrolled speaker row.
    pub async fn set_speaker_voiceprint(
        &self,
        speaker_id: &str,
        new_centroid: &[f32],
    ) -> AppResult<Speaker> {
        let existing: Option<Speaker> = sqlx::query_as("SELECT * FROM speakers WHERE id = ?1")
            .bind(speaker_id)
            .fetch_optional(&self.pool)
            .await?;
        let existing =
            existing.ok_or_else(|| AppError::not_found(format!("speaker {speaker_id}")))?;

        let blended = match existing
            .voiceprint_centroid
            .as_deref()
            .and_then(memo_diarize::decode_centroid_bytes)
        {
            Some(prev) if prev.len() == new_centroid.len() => {
                let mut sum: Vec<f32> = prev
                    .iter()
                    .zip(new_centroid.iter())
                    .map(|(a, b)| a * 0.5 + b * 0.5)
                    .collect();
                let norm = sum.iter().map(|v| v * v).sum::<f32>().sqrt();
                if norm > 1e-8 {
                    for v in &mut sum {
                        *v /= norm;
                    }
                }
                sum
            }
            _ => new_centroid.to_vec(),
        };
        let encoded = memo_diarize::encode_centroid_bytes(&blended);

        {
            let _guard = self.write_lock.lock().await;
            sqlx::query("UPDATE speakers SET voiceprint_centroid = ?1 WHERE id = ?2")
                .bind(&encoded)
                .bind(speaker_id)
                .execute(&self.pool)
                .await?;
        }

        Ok(
            sqlx::query_as::<_, Speaker>("SELECT * FROM speakers WHERE id = ?1")
                .bind(speaker_id)
                .fetch_one(&self.pool)
                .await?,
        )
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
        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
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
            .execute(&mut *tx)
            .await?;
            if shot.ocr_extracted_text.is_some() {
                Self::refresh_meeting_fts(&mut tx, meeting_id).await?;
            }
            tx.commit().await?;
        }
        self.get_screenshot(&id).await
    }

    pub async fn get_screenshot(&self, id: &str) -> AppResult<Screenshot> {
        sqlx::query_as::<_, Screenshot>("SELECT * FROM screenshots WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::not_found(format!("screenshot {id}")))
    }

    pub async fn latest_screenshot(&self, meeting_id: &str) -> AppResult<Option<Screenshot>> {
        Ok(sqlx::query_as::<_, Screenshot>(
            "SELECT * FROM screenshots WHERE meeting_id = ?1 ORDER BY start_ms DESC, rowid DESC LIMIT 1",
        )
        .bind(meeting_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn list_screenshots(&self, meeting_id: &str) -> AppResult<Vec<Screenshot>> {
        Ok(sqlx::query_as::<_, Screenshot>(
            "SELECT * FROM screenshots WHERE meeting_id = ?1 ORDER BY start_ms ASC",
        )
        .bind(meeting_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn delete_screenshot(&self, id: &str) -> AppResult<Screenshot> {
        let shot = self.get_screenshot(id).await?;
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM screenshots WHERE id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if shot.ocr_extracted_text.is_some() {
            Self::refresh_meeting_fts(&mut tx, &shot.meeting_id).await?;
        }
        tx.commit().await?;
        Ok(shot)
    }

    pub async fn extend_screenshot(&self, id: &str, end_ms: i64) -> AppResult<()> {
        let _guard = self.write_lock.lock().await;
        sqlx::query("UPDATE screenshots SET end_ms = MAX(end_ms, ?1) WHERE id = ?2")
            .bind(end_ms)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn update_screenshot_ocr(&self, id: &str, text: &str) -> AppResult<()> {
        let shot = self.get_screenshot(id).await?;
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE screenshots SET ocr_extracted_text = ?1 WHERE id = ?2")
            .bind(text)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        Self::refresh_meeting_fts(&mut tx, &shot.meeting_id).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Atomically replace AI-generated synthesis items while preserving user-edited
    /// rows and carrying forward `is_completed` state on matching action items.
    pub async fn replace_synthesis_items(
        &self,
        meeting_id: &str,
        items: Vec<SynthesisItemDraft>,
    ) -> AppResult<Vec<SynthesisItem>> {
        self.get_meeting(meeting_id).await?;
        let existing = self.list_synthesis_items(meeting_id).await?;
        let completed_contents: std::collections::HashSet<String> = existing
            .iter()
            .filter(|row| row.is_completed)
            .map(|row| normalize_item_key(&row.item_type, &row.content))
            .collect();
        let preserved_edits: Vec<SynthesisItem> = existing
            .into_iter()
            .filter(|row| row.is_user_edited)
            .collect();

        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
            sqlx::query("DELETE FROM synthesis_items WHERE meeting_id = ?1 AND is_user_edited = 0")
                .bind(meeting_id)
                .execute(&mut *tx)
                .await?;

            let preserved_keys: std::collections::HashSet<String> = preserved_edits
                .iter()
                .map(|row| normalize_item_key(&row.item_type, &row.content))
                .collect();

            for item in items {
                let key = normalize_item_key(&item.item_type, &item.content);
                if preserved_keys.contains(&key) {
                    continue;
                }
                let is_completed = item.is_completed || completed_contents.contains(&key);
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
                .bind(is_completed)
                .bind(item.is_user_edited)
                .bind(serde_json::to_string(&item.evidence_refs)?)
                .execute(&mut *tx)
                .await?;
            }
            Self::refresh_meeting_fts(&mut tx, meeting_id).await?;
            tx.commit().await?;
        }
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

    pub async fn insert_user_synthesis_item(
        &self,
        meeting_id: &str,
        item_type: &str,
        content: &str,
        owner: Option<&str>,
        deadline: Option<&str>,
    ) -> AppResult<SynthesisItem> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return Err(AppError::Invalid("content must not be empty".into()));
        }
        self.get_meeting(meeting_id).await?;
        let id = Uuid::now_v7().to_string();
        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
            let max_order: (i64,) = sqlx::query_as(
                "SELECT COALESCE(MAX(sort_order), -1) FROM synthesis_items WHERE meeting_id = ?1 AND item_type = ?2",
            )
            .bind(meeting_id)
            .bind(item_type)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query(
                r#"
                INSERT INTO synthesis_items (
                    id, meeting_id, item_type, sort_order, content, rationale, owner, deadline,
                    is_completed, is_user_edited, evidence_refs_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, 0, 1, '[]')
                "#,
            )
            .bind(&id)
            .bind(meeting_id)
            .bind(item_type)
            .bind(max_order.0 + 1)
            .bind(trimmed)
            .bind(owner)
            .bind(deadline)
            .execute(&mut *tx)
            .await?;
            Self::refresh_meeting_fts(&mut tx, meeting_id).await?;
            tx.commit().await?;
        }
        Ok(
            sqlx::query_as("SELECT * FROM synthesis_items WHERE id = ?1")
                .bind(&id)
                .fetch_one(&self.pool)
                .await?,
        )
    }

    pub async fn update_synthesis_item(
        &self,
        item_id: &str,
        patch: SynthesisItemPatch,
    ) -> AppResult<SynthesisItem> {
        let current: Option<SynthesisItem> =
            sqlx::query_as("SELECT * FROM synthesis_items WHERE id = ?1")
                .bind(item_id)
                .fetch_optional(&self.pool)
                .await?;
        let current =
            current.ok_or_else(|| AppError::not_found(format!("synthesis item {item_id}")))?;

        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
            sqlx::query(
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
            .bind(&patch.content)
            .bind(&patch.rationale)
            .bind(&patch.owner)
            .bind(&patch.deadline)
            .bind(patch.is_completed)
            .bind(item_id)
            .execute(&mut *tx)
            .await?;
            if patch.content.is_some() {
                Self::refresh_meeting_fts(&mut tx, &current.meeting_id).await?;
            }
            tx.commit().await?;
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
        let _guard = self.write_lock.lock().await;
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

    pub async fn rename_folder(&self, folder_id: &str, name: &str) -> AppResult<Folder> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("folder name is empty".into()));
        }
        let _guard = self.write_lock.lock().await;
        let result = sqlx::query("UPDATE folders SET name = ?1 WHERE id = ?2")
            .bind(name)
            .bind(folder_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!("folder {folder_id}")));
        }
        Ok(sqlx::query_as::<_, Folder>(
            "SELECT id, name, parent_id, created_at FROM folders WHERE id = ?1",
        )
        .bind(folder_id)
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn delete_folder(&self, folder_id: &str) -> AppResult<()> {
        let _guard = self.write_lock.lock().await;
        let result = sqlx::query("DELETE FROM folders WHERE id = ?1")
            .bind(folder_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!("folder {folder_id}")));
        }
        Ok(())
    }

    pub async fn list_folders(&self) -> AppResult<Vec<Folder>> {
        Ok(sqlx::query_as::<_, Folder>(
            "SELECT id, name, parent_id, created_at FROM folders ORDER BY name COLLATE NOCASE",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn set_meeting_tags(
        &self,
        meeting_id: &str,
        tags: Vec<String>,
    ) -> AppResult<Vec<String>> {
        self.get_meeting(meeting_id).await?;
        let mut normalized = std::collections::BTreeSet::new();
        for tag in tags {
            let trimmed = tag.trim().to_lowercase();
            if !trimmed.is_empty() {
                normalized.insert(trimmed);
            }
        }
        {
            let _guard = self.write_lock.lock().await;
            let mut tx = self.pool.begin().await?;
            sqlx::query("DELETE FROM meeting_tags WHERE meeting_id = ?1")
                .bind(meeting_id)
                .execute(&mut *tx)
                .await?;
            for tag in &normalized {
                sqlx::query("INSERT INTO meeting_tags (id, meeting_id, tag) VALUES (?1, ?2, ?3)")
                    .bind(Uuid::now_v7().to_string())
                    .bind(meeting_id)
                    .bind(tag)
                    .execute(&mut *tx)
                    .await?;
            }
            Self::refresh_meeting_fts(&mut tx, meeting_id).await?;
            tx.commit().await?;
        }
        Ok(normalized.into_iter().collect())
    }

    pub async fn get_meeting_tags(&self, meeting_id: &str) -> AppResult<Vec<String>> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT tag FROM meeting_tags WHERE meeting_id = ?1 ORDER BY tag ASC")
                .bind(meeting_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.into_iter().map(|(tag,)| tag).collect())
    }

    pub async fn list_all_tags(&self) -> AppResult<Vec<String>> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT DISTINCT tag FROM meeting_tags ORDER BY tag ASC")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.into_iter().map(|(tag,)| tag).collect())
    }

    pub async fn vault_counts(&self) -> AppResult<VaultCounts> {
        let (meetings,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM meetings")
            .fetch_one(&self.pool)
            .await?;
        let (transcript_segments,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM transcript_segments")
                .fetch_one(&self.pool)
                .await?;
        let (note_blocks,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM note_blocks")
            .fetch_one(&self.pool)
            .await?;
        let (screenshots,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM screenshots")
            .fetch_one(&self.pool)
            .await?;
        let (synthesis_items,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM synthesis_items")
            .fetch_one(&self.pool)
            .await?;
        let (speakers,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM speakers")
            .fetch_one(&self.pool)
            .await?;
        let (folders,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM folders")
            .fetch_one(&self.pool)
            .await?;
        Ok(VaultCounts {
            meetings,
            transcript_segments,
            note_blocks,
            screenshots,
            synthesis_items,
            speakers,
            folders,
        })
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
        // Use non-HTML sentinel bytes `\x01` and `\x02` inside SQLite `snippet()`,
        // HTML-escape raw user/transcript characters first, then emit `<mark>` tags
        // so stored text containing `<img onerror=...>` can never execute XSS.
        let mut builder = QueryBuilder::<Sqlite>::new(
            r#"
            SELECT
                f.meeting_id AS meeting_id,
                m.title AS title,
                snippet(meetings_search_fts, 2, char(1), char(2), '…', 24) AS notes_snippet,
                snippet(meetings_search_fts, 3, char(1), char(2), '…', 24) AS transcript_snippet,
                snippet(meetings_search_fts, 4, char(1), char(2), '…', 24) AS synthesis_snippet,
                snippet(meetings_search_fts, 5, char(1), char(2), '…', 24) AS slide_snippet,
                bm25(meetings_search_fts, 0.0, 12.0, 8.0, 2.0, 5.0, 6.0, 3.0) AS rank
            FROM meetings_search_fts f
            JOIN meetings m ON m.id = f.meeting_id
            WHERE meetings_search_fts MATCH
            "#,
        );
        builder.push_bind(fts_query);
        if let Some(meeting_id) = filters.meeting_id {
            builder.push(" AND m.id = ").push_bind(meeting_id);
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
                let raw_snippet = candidates
                    .iter()
                    .flatten()
                    .find(|candidate| candidate.contains('\x01'))
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
                    snippet: sanitize_fts_snippet(&raw_snippet),
                    rank: row.rank,
                }
            })
            .collect())
    }

    pub async fn rebuild_search_index(&self) -> AppResult<()> {
        let _guard = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM meeting_fts_map")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM meetings_search_fts")
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"
            INSERT INTO meetings_search_fts (
                meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
            )
            SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
            FROM meeting_search_documents
            "#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO meeting_fts_map (meeting_id, fts_rowid) SELECT meeting_id, rowid FROM meetings_search_fts",
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete_meeting(&self, meeting_id: &str) -> AppResult<()> {
        let _guard = self.write_lock.lock().await;
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

fn normalize_item_key(item_type: &str, content: &str) -> String {
    format!(
        "{}::{}",
        item_type.trim().to_ascii_lowercase(),
        content
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase()
    )
}

pub fn sanitize_fts_snippet(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 16);
    for ch in raw.chars() {
        match ch {
            '\x01' => out.push_str("<mark>"),
            '\x02' => out.push_str("</mark>"),
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
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
    use crate::brand::Brand;
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
    async fn large_transcript_replace_completes_without_quadratic_fts_blowup() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput {
                title: Some("Two-Hour Board Review".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        let segments: Vec<NewTranscriptSegment> = (1..=1_500)
            .map(|seq| {
                transcript_seg(
                    seq,
                    &format!("Segment {seq} discussing Kubernetes ingress latency."),
                )
            })
            .collect();

        let started = std::time::Instant::now();
        let stored = db.replace_transcript(&meeting.id, segments).await.unwrap();
        let elapsed = started.elapsed();
        assert_eq!(stored.len(), 1_500);
        assert!(
            elapsed < Duration::from_secs(2),
            "1500-segment replace took too long: {elapsed:?}"
        );

        let hits = db
            .search("Kubernetes", SearchFilters::default())
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("<mark>Kubernetes</mark>"));
    }

    #[tokio::test]
    async fn search_snippets_escape_html_and_prevent_xss() {
        let db = db().await;
        let meeting = db
            .create_meeting(CreateMeetingInput {
                title: Some("XSS Check".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        db.save_note_blocks(
            &meeting.id,
            "Payload <img src=x onerror=alert('pwn')> around PostgreSQL migration.",
            vec![note(
                1,
                "Payload <img src=x onerror=alert('pwn')> around PostgreSQL migration.",
            )],
        )
        .await
        .unwrap();

        let hits = db
            .search("PostgreSQL", SearchFilters::default())
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("<mark>PostgreSQL</mark>"));
        assert!(!hits[0].snippet.contains("<img"));
        assert!(hits[0]
            .snippet
            .contains("&lt;img src=x onerror=alert(&#39;pwn&#39;)&gt;"));
    }

    #[tokio::test]
    async fn crash_recovery_salvages_unfinalized_wav_and_finalizes_meeting() {
        let temp = tempfile::tempdir().unwrap();
        let brand = Brand::embedded().unwrap();
        let paths = BrandPaths::from_roots(
            brand.manifest(),
            temp.path().join("data"),
            temp.path().join("cache"),
        );
        paths.ensure().unwrap();
        let db = Database::connect(&paths.db_path).await.unwrap();

        let meeting = db
            .create_meeting(CreateMeetingInput {
                title: Some("Interrupted Call".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(meeting.status, STATUS_RECORDING);
        assert!(meeting.audio_file_path.is_none());

        // Write an unfinalized WAV (`data_len = 0`, skipping Drop via `mem::forget`).
        let wav_path = paths.meeting_media_dir(&meeting.id).join("audio.wav");
        std::fs::create_dir_all(wav_path.parent().unwrap()).unwrap();
        {
            let file = std::fs::File::create(&wav_path).unwrap();
            let spec = memo_audio_capture::WavSpec::new(16_000, 1).unwrap();
            let mut writer = memo_audio_capture::WavWriter::new(file, spec).unwrap();
            writer.write_samples(&vec![0.2; 32_000]).unwrap();
            std::mem::forget(writer);
        }

        let recovered = db.recover_interrupted_meetings(&paths).await.unwrap();
        assert_eq!(recovered, 1);

        let after = db.get_meeting(&meeting.id).await.unwrap();
        assert_eq!(after.status, STATUS_COMPLETED);
        assert_eq!(after.duration_ms, 2_000);
        assert_eq!(
            after.audio_file_path.as_deref(),
            Some(wav_path.to_string_lossy().as_ref())
        );
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
            "meeting_fts_map",
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

        let renamed = db
            .update_meeting(
                &meeting.id,
                UpdateMeetingPatch {
                    title: Some("Q3 Launch Confirmed".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(renamed.title, "Q3 Launch Confirmed");

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
    async fn speaker_rename_updates_transcript_search_and_preserves_cluster() {
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

        // Even before manual rename, unrenamed diarized speaker labels are indexed in FTS.
        let initial_hits = db
            .search("Speaker", SearchFilters::default())
            .await
            .unwrap();
        assert_eq!(initial_hits.len(), 1);

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

        // Re-renaming by original cluster ("Speaker 1") still works cleanly.
        db.rename_speaker(&meeting.id, "Speaker 1", "Jordan", false)
            .await
            .unwrap();
        let transcript = db.list_transcript(&meeting.id).await.unwrap();
        assert_eq!(transcript[0].speaker_label, "Jordan");
    }

    #[tokio::test]
    async fn synthesis_items_roundtrip_and_user_edits_survive_resynthesis() {
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

        // Re-synthesizing preserves the user-edited completed action item AND
        // supports custom white-label item_type slugs (e.g. SOAP 'subjective').
        let resynthesized = db
            .replace_synthesis_items(
                &meeting.id,
                vec![
                    SynthesisItemDraft {
                        item_type: "subjective".into(),
                        sort_order: 0,
                        content: "Patient reports improved adherence.".into(),
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
        assert_eq!(resynthesized.len(), 2);
        let kept_action = resynthesized
            .iter()
            .find(|item| item.item_type == "action_item")
            .unwrap();
        assert!(kept_action.is_completed);
        assert!(kept_action.is_user_edited);
    }

    #[tokio::test]
    async fn screenshot_ocr_tags_and_folders_crud_roundtrip() {
        let db = db().await;
        let folder = db.create_folder("Clinical", None).await.unwrap();
        let renamed_folder = db
            .rename_folder(&folder.id, "Clinical Intake")
            .await
            .unwrap();
        assert_eq!(renamed_folder.name, "Clinical Intake");

        let meeting = db
            .create_meeting(CreateMeetingInput {
                folder_id: Some(folder.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap();

        let tags = db
            .set_meeting_tags(&meeting.id, vec!["HIPAA".into(), "Intake".into()])
            .await
            .unwrap();
        assert_eq!(tags, vec!["hipaa", "intake"]);
        assert_eq!(db.list_all_tags().await.unwrap(), vec!["hipaa", "intake"]);
        assert_eq!(
            db.search("hipaa", SearchFilters::default())
                .await
                .unwrap()
                .len(),
            1
        );

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

        db.delete_screenshot(&shot.id).await.unwrap();
        assert!(db
            .search("FedRAMP", SearchFilters::default())
            .await
            .unwrap()
            .is_empty());

        db.delete_folder(&folder.id).await.unwrap();
        assert_eq!(db.get_meeting(&meeting.id).await.unwrap().folder_id, None);
    }
}
