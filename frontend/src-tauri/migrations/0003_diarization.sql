-- Post-hoc acoustic diarization can be enabled per meeting. The default keeps
-- existing rows working and means new recordings are diarized when the host
-- can separate voices.
ALTER TABLE meetings ADD COLUMN diarization_enabled INTEGER NOT NULL DEFAULT 1;
