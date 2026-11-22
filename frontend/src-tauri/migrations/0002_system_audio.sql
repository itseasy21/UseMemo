-- Second capture archive for system-audio loopback.
--
-- It is deliberately a separate file from the microphone master: a failed or
-- silent loopback must not change the local take, and keeping the channels
-- apart is what lets the transcript label "You" versus "Them" without
-- guessing from voice characteristics.
ALTER TABLE meetings ADD COLUMN system_audio_file_path TEXT;

-- Offset of the first captured system frame from the start of the take. The
-- loopback stream can begin after the microphone, so transcription needs this
-- to put both archives on one timeline.
ALTER TABLE meetings ADD COLUMN system_audio_started_at_ms INTEGER NOT NULL DEFAULT 0;
