-- 0004_production_vault.sql
--
-- Fixes O(N^2) per-row FTS5 full-table scan/re-tokenization triggers, preserves
-- raw diarization cluster labels for non-destructive speaker renaming, indexes
-- unrenamed speaker labels + tags in FTS5, Orders transcript FTS concatenation
-- by seq_no, and relaxes synthesis_items.item_type so brand profiles can define
-- domain-specific synthesis templates (e.g. Clinical SOAP notes).

-- 1. Drop legacy per-row FTS5 triggers from 0001_initial.sql.
DROP TRIGGER IF EXISTS meetings_search_ai;
DROP TRIGGER IF EXISTS meetings_search_au;
DROP TRIGGER IF EXISTS meetings_search_ad;
DROP TRIGGER IF EXISTS note_blocks_search_ai;
DROP TRIGGER IF EXISTS note_blocks_search_au;
DROP TRIGGER IF EXISTS note_blocks_search_ad;
DROP TRIGGER IF EXISTS transcript_search_ai;
DROP TRIGGER IF EXISTS transcript_search_au;
DROP TRIGGER IF EXISTS transcript_search_ad;
DROP TRIGGER IF EXISTS screenshots_search_ai;
DROP TRIGGER IF EXISTS screenshots_search_au;
DROP TRIGGER IF EXISTS screenshots_search_ad;
DROP TRIGGER IF EXISTS synthesis_search_ai;
DROP TRIGGER IF EXISTS synthesis_search_au;
DROP TRIGGER IF EXISTS synthesis_search_ad;
DROP TRIGGER IF EXISTS speakers_search_au;
DROP TRIGGER IF EXISTS speakers_search_ad;

-- 2. Preserve original acoustic cluster IDs alongside user-renamed display labels.
ALTER TABLE transcript_segments ADD COLUMN raw_speaker_cluster TEXT;
UPDATE transcript_segments SET raw_speaker_cluster = speaker_label WHERE raw_speaker_cluster IS NULL;

-- 3. Relax synthesis_items.item_type CHECK constraint for custom white-label templates.
CREATE TABLE synthesis_items_v2 (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (length(trim(item_type)) > 0),
    sort_order INTEGER NOT NULL,
    content TEXT NOT NULL,
    rationale TEXT,
    owner TEXT,
    deadline TEXT,
    is_completed BOOLEAN NOT NULL DEFAULT 0,
    is_user_edited BOOLEAN NOT NULL DEFAULT 0,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO synthesis_items_v2 (
    id, meeting_id, item_type, sort_order, content, rationale, owner, deadline,
    is_completed, is_user_edited, evidence_refs_json
)
SELECT
    id, meeting_id, item_type, sort_order, content, rationale, owner, deadline,
    is_completed, is_user_edited, evidence_refs_json
FROM synthesis_items;

-- Drop the dependent view before swapping synthesis_items so SQLite schema
-- validation during ALTER TABLE RENAME never sees a dangling table reference.
DROP VIEW IF EXISTS meeting_search_documents;

DROP TABLE synthesis_items;
ALTER TABLE synthesis_items_v2 RENAME TO synthesis_items;
CREATE INDEX idx_synthesis_meeting ON synthesis_items (meeting_id, item_type, sort_order);

-- 4. Recreate meeting_search_documents view with ordered transcript, tags, and all speaker labels.
CREATE VIEW meeting_search_documents AS
SELECT
    m.id AS meeting_id,
    m.title AS title,
    TRIM(
        m.manual_notes_raw_md || ' ' || COALESCE((
            SELECT group_concat(mt.tag, ' ')
            FROM meeting_tags mt
            WHERE mt.meeting_id = m.id
        ), '')
    ) AS manual_notes,
    COALESCE((
        SELECT group_concat(ordered_ts.text, ' ')
        FROM (
            SELECT ts.text
            FROM transcript_segments ts
            WHERE ts.meeting_id = m.id
            ORDER BY ts.seq_no ASC
        ) ordered_ts
    ), '') AS transcript_body,
    COALESCE((
        SELECT group_concat(ordered_si.content, ' ')
        FROM (
            SELECT si.content
            FROM synthesis_items si
            WHERE si.meeting_id = m.id
            ORDER BY si.sort_order ASC
        ) ordered_si
    ), '') AS synthesis_body,
    COALESCE((
        SELECT group_concat(ordered_sc.ocr_extracted_text, ' ')
        FROM (
            SELECT s.ocr_extracted_text
            FROM screenshots s
            WHERE s.meeting_id = m.id AND s.ocr_extracted_text IS NOT NULL
            ORDER BY s.start_ms ASC
        ) ordered_sc
    ), '') AS slide_ocr_body,
    COALESCE((
        SELECT group_concat(label, ' ')
        FROM (
            SELECT DISTINCT COALESCE(sp.display_name, ts.speaker_label) AS label
            FROM transcript_segments ts
            LEFT JOIN speakers sp ON sp.id = ts.speaker_id
            WHERE ts.meeting_id = m.id
        )
    ), '') AS speaker_names
FROM meetings m;

-- 5. O(1) primary-key mapping from meeting_id -> FTS5 rowid (eliminating full-table FTS scans).
CREATE TABLE meeting_fts_map (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    fts_rowid INTEGER NOT NULL UNIQUE
);

-- Automatic O(1) cleanup of FTS5 row when a meeting is deleted (BEFORE CASCADE removes meeting_fts_map).
CREATE TRIGGER meetings_search_bd BEFORE DELETE ON meetings BEGIN
    DELETE FROM meetings_search_fts
    WHERE rowid IN (SELECT fts_rowid FROM meeting_fts_map WHERE meeting_id = OLD.id);
END;

-- Rebuild FTS5 + rowid map for any existing meetings.
DELETE FROM meetings_search_fts;
INSERT INTO meetings_search_fts (
    meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
)
SELECT
    meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
FROM meeting_search_documents;

INSERT INTO meeting_fts_map (meeting_id, fts_rowid)
SELECT meeting_id, rowid FROM meetings_search_fts;
