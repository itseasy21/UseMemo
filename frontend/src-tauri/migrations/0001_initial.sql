-- Use Memo vault schema: meetings, indexed notes, speakers, diarized transcript,
-- perceptual screenshot frames, grounded synthesis items, folders/tags, and FTS5.

CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
);

CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'recording'
        CHECK (status IN ('recording', 'processing', 'completed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    audio_file_path TEXT,
    screenshot_interval_sec INTEGER NOT NULL DEFAULT 10,
    asr_model_id TEXT NOT NULL,
    slm_model_id TEXT NOT NULL,
    manual_notes_raw_md TEXT NOT NULL DEFAULT '',
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    is_starred BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE meeting_tags (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    UNIQUE (meeting_id, tag)
);

CREATE TABLE note_blocks (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    line_index INTEGER NOT NULL,
    block_type TEXT NOT NULL DEFAULT 'paragraph'
        CHECK (block_type IN ('paragraph', 'decision', 'todo', 'heading', 'bookmark')),
    content_md TEXT NOT NULL,
    recording_offset_ms INTEGER,
    linked_screenshot_id TEXT REFERENCES screenshots(id) ON DELETE SET NULL,
    UNIQUE (meeting_id, line_index)
);

CREATE TABLE speakers (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    color_hex TEXT NOT NULL,
    voiceprint_centroid BLOB,
    is_local_user BOOLEAN NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE transcript_segments (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    seq_no INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    speaker_id TEXT REFERENCES speakers(id) ON DELETE SET NULL,
    speaker_label TEXT NOT NULL,
    audio_channel TEXT NOT NULL CHECK (audio_channel IN ('mic', 'system')),
    text TEXT NOT NULL,
    is_confirmed BOOLEAN NOT NULL DEFAULT 1,
    UNIQUE (meeting_id, seq_no)
);

CREATE TABLE screenshots (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    dhash TEXT NOT NULL,
    capture_trigger TEXT NOT NULL CHECK (capture_trigger IN ('interval', 'manual')),
    ocr_extracted_text TEXT
);

CREATE TABLE synthesis_items (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('summary', 'decision', 'action_item')),
    sort_order INTEGER NOT NULL,
    content TEXT NOT NULL,
    rationale TEXT,
    owner TEXT,
    deadline TEXT,
    is_completed BOOLEAN NOT NULL DEFAULT 0,
    is_user_edited BOOLEAN NOT NULL DEFAULT 0,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_meetings_created ON meetings (created_at DESC);
CREATE INDEX idx_meetings_folder ON meetings (folder_id);
CREATE INDEX idx_note_blocks_meeting ON note_blocks (meeting_id, line_index);
CREATE INDEX idx_transcript_meeting ON transcript_segments (meeting_id, start_ms);
CREATE INDEX idx_transcript_speaker ON transcript_segments (speaker_id);
CREATE INDEX idx_screenshots_meeting ON screenshots (meeting_id, start_ms);
CREATE INDEX idx_synthesis_meeting ON synthesis_items (meeting_id, item_type, sort_order);
CREATE INDEX idx_meeting_tags_tag ON meeting_tags (tag);

-- Aggregation view used by every FTS refresh trigger.
CREATE VIEW meeting_search_documents AS
SELECT
    m.id AS meeting_id,
    m.title AS title,
    m.manual_notes_raw_md AS manual_notes,
    COALESCE((
        SELECT group_concat(ts.text, ' ')
        FROM transcript_segments ts
        WHERE ts.meeting_id = m.id
    ), '') AS transcript_body,
    COALESCE((
        SELECT group_concat(si.content, ' ')
        FROM synthesis_items si
        WHERE si.meeting_id = m.id
    ), '') AS synthesis_body,
    COALESCE((
        SELECT group_concat(s.ocr_extracted_text, ' ')
        FROM screenshots s
        WHERE s.meeting_id = m.id AND s.ocr_extracted_text IS NOT NULL
    ), '') AS slide_ocr_body,
    COALESCE((
        SELECT group_concat(DISTINCT sp.display_name)
        FROM transcript_segments ts
        JOIN speakers sp ON sp.id = ts.speaker_id
        WHERE ts.meeting_id = m.id
    ), '') AS speaker_names
FROM meetings m;

CREATE VIRTUAL TABLE meetings_search_fts USING fts5(
    meeting_id UNINDEXED,
    title,
    manual_notes,
    transcript_body,
    synthesis_body,
    slide_ocr_body,
    speaker_names,
    tokenize = 'porter unicode61 remove_diacritics 1'
);

-- meetings
CREATE TRIGGER meetings_search_ai AFTER INSERT ON meetings BEGIN
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.id;
END;

CREATE TRIGGER meetings_search_au AFTER UPDATE ON meetings BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = NEW.id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.id;
END;

CREATE TRIGGER meetings_search_ad AFTER DELETE ON meetings BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = OLD.id;
END;

-- note blocks
CREATE TRIGGER note_blocks_search_ai AFTER INSERT ON note_blocks BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = NEW.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.meeting_id;
END;

CREATE TRIGGER note_blocks_search_au AFTER UPDATE ON note_blocks BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = NEW.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.meeting_id;
END;

CREATE TRIGGER note_blocks_search_ad AFTER DELETE ON note_blocks BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = OLD.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = OLD.meeting_id;
END;

-- transcript segments
CREATE TRIGGER transcript_search_ai AFTER INSERT ON transcript_segments BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = NEW.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.meeting_id;
END;

CREATE TRIGGER transcript_search_au AFTER UPDATE ON transcript_segments BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = NEW.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.meeting_id;
END;

CREATE TRIGGER transcript_search_ad AFTER DELETE ON transcript_segments BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = OLD.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = OLD.meeting_id;
END;

-- screenshots
CREATE TRIGGER screenshots_search_ai AFTER INSERT ON screenshots BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = NEW.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.meeting_id;
END;

CREATE TRIGGER screenshots_search_au AFTER UPDATE ON screenshots BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = NEW.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.meeting_id;
END;

CREATE TRIGGER screenshots_search_ad AFTER DELETE ON screenshots BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = OLD.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = OLD.meeting_id;
END;

-- synthesis items
CREATE TRIGGER synthesis_search_ai AFTER INSERT ON synthesis_items BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = NEW.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.meeting_id;
END;

CREATE TRIGGER synthesis_search_au AFTER UPDATE ON synthesis_items BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = NEW.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = NEW.meeting_id;
END;

CREATE TRIGGER synthesis_search_ad AFTER DELETE ON synthesis_items BEGIN
    DELETE FROM meetings_search_fts WHERE meeting_id = OLD.meeting_id;
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents WHERE meeting_id = OLD.meeting_id;
END;

-- speaker renaming affects indexed speaker names
CREATE TRIGGER speakers_search_au AFTER UPDATE ON speakers BEGIN
    DELETE FROM meetings_search_fts
    WHERE meeting_id IN (SELECT DISTINCT meeting_id FROM transcript_segments WHERE speaker_id = NEW.id);
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents
    WHERE meeting_id IN (SELECT DISTINCT meeting_id FROM transcript_segments WHERE speaker_id = NEW.id);
END;

CREATE TRIGGER speakers_search_ad AFTER DELETE ON speakers BEGIN
    DELETE FROM meetings_search_fts
    WHERE meeting_id IN (SELECT DISTINCT meeting_id FROM transcript_segments WHERE speaker_id = OLD.id);
    INSERT INTO meetings_search_fts
    SELECT meeting_id, title, manual_notes, transcript_body, synthesis_body, slide_ocr_body, speaker_names
    FROM meeting_search_documents
    WHERE meeting_id IN (SELECT DISTINCT meeting_id FROM transcript_segments WHERE speaker_id = OLD.id);
END;
