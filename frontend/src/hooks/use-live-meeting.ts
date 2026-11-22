"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  useAsrSegmentDeltas,
  useMeetingChanged,
  useRecordingStopped,
  useScreenshotCaptured,
} from "@/hooks/use-host-event";
import { FEATURED_MEETING, findDemoMeeting, type Meeting } from "@/lib/demo-data";
import {
  getMeeting,
  getMeetingTags,
  listFolders,
  listNotes,
  listScreenshots,
  listSpeakers,
  listSynthesis,
  listTranscript,
  type VaultCountsRecord,
} from "@/lib/host";
import { adaptMeetingToStudio, adaptScreenshotRecord } from "@/lib/meeting-adapter";
import { formatHostError, isTauri } from "@/lib/tauri";

export type LiveMeetingState = {
  meeting: Meeting | null;
  loading: boolean;
  notFound: boolean;
  error: string | null;
  reload: () => Promise<void>;
  mutateMeeting: (updater: (current: Meeting) => Meeting) => void;
};

export type { VaultCountsRecord };

export function useLiveMeeting(meetingId: string | null): LiveMeetingState {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    if (!isTauri()) {
      if (!meetingId) {
        setMeeting({ ...FEATURED_MEETING, isDemo: true });
        setNotFound(false);
        setError(null);
        setLoading(false);
        return;
      }
      const demo = findDemoMeeting(meetingId);
      if (!demo) {
        setMeeting(null);
        setNotFound(true);
        setError(null);
      } else {
        setMeeting(demo);
        setNotFound(false);
        setError(null);
      }
      setLoading(false);
      return;
    }

    if (!meetingId) {
      setMeeting(null);
      setNotFound(true);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading((prev) => (meeting ? prev : true));
    setError(null);

    try {
      const [meetingRecord, notes, transcript, screenshots, synthesis, speakers, folders, tags] =
        await Promise.all([
          getMeeting(meetingId),
          listNotes(meetingId),
          listTranscript(meetingId),
          listScreenshots(meetingId),
          listSynthesis(meetingId),
          listSpeakers(),
          listFolders(),
          getMeetingTags(meetingId),
        ]);

      if (reqId !== requestIdRef.current) return;
      if (!meetingRecord) {
        setMeeting(null);
        setNotFound(true);
        setLoading(false);
        return;
      }

      const adapted = adaptMeetingToStudio({
        meeting: meetingRecord,
        notes: notes ?? [],
        transcript: transcript ?? [],
        screenshots: screenshots ?? [],
        synthesis: synthesis ?? [],
        speakers: speakers ?? [],
        folders: folders ?? [],
        tags: tags ?? [],
      });

      setMeeting(adapted);
      setNotFound(false);
      setError(null);
    } catch (cause) {
      if (reqId !== requestIdRef.current) return;
      const message = formatHostError(cause);
      if (message.toLowerCase().includes("not found")) {
        setMeeting(null);
        setNotFound(true);
        setError(null);
      } else {
        setError(message);
      }
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [meeting, meetingId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  useMeetingChanged(
    (payload) => {
      if (!meetingId || payload.meeting.id !== meetingId) return;
      setMeeting((current) => {
        if (!current) return current;
        return {
          ...current,
          title: payload.meeting.title,
          status: payload.meeting.status,
          updatedAt: payload.meeting.updatedAt,
          durationMs: Math.max(current.durationMs, payload.meeting.durationMs),
          audioFilePath: payload.meeting.audioFilePath,
          systemAudioFilePath: payload.meeting.systemAudioFilePath,
          systemAudioStartedAtMs: payload.meeting.systemAudioStartedAtMs,
          diarizationEnabled: payload.meeting.diarizationEnabled,
          screenshotIntervalSec: payload.meeting.screenshotIntervalSec,
          asrModelId: payload.meeting.asrModelId,
          slmModelId: payload.meeting.slmModelId,
          folderId: payload.meeting.folderId,
          isStarred: payload.meeting.isStarred,
        };
      });
    },
    Boolean(meetingId) && isTauri(),
  );

  useRecordingStopped(
    (payload) => {
      if (!meetingId || payload.meetingId !== meetingId) return;
      void load();
    },
    Boolean(meetingId) && isTauri(),
  );

  useScreenshotCaptured(
    (payload) => {
      if (!meetingId || payload.meetingId !== meetingId || !payload.screenshot) return;
      const shot = payload.screenshot;
      setMeeting((current) => {
        if (!current) return current;
        if (current.screenshots.some((item) => item.id === shot.id)) return current;
        const nextShots = [
          ...current.screenshots,
          adaptScreenshotRecord(shot, current.screenshots.length),
        ].sort((a, b) => a.startMs - b.startMs);
        return {
          ...current,
          durationMs: Math.max(current.durationMs, shot.endMs),
          screenshots: nextShots,
        };
      });
    },
    Boolean(meetingId) && isTauri(),
  );

  useAsrSegmentDeltas(
    (payload) => {
      if (!meetingId || payload.meetingId !== meetingId) return;
      setMeeting((current) => {
        if (!current) return current;
        const rawLabel = payload.speakerLabel.trim() || "Speaker";
        const slug = rawLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const speakerId =
          current.participants.find((p) => p.name.toLowerCase() === rawLabel.toLowerCase())?.id ??
          `spk-${slug}`;
        const nextParticipants = current.participants.some((p) => p.id === speakerId)
          ? current.participants
          : [
              ...current.participants,
              {
                id: speakerId,
                name: rawLabel,
                role: rawLabel.toLowerCase() === "you" ? "Local mic" : "Participant",
                tone: rawLabel.toLowerCase() === "you" ? ("violet" as const) : ("accent" as const),
                isYou: rawLabel.toLowerCase() === "you",
              },
            ];

        const segId = `live-seq-${payload.seqNo}`;
        const existingIndex = current.transcripts.findIndex(
          (seg) => seg.seqNo === payload.seqNo || seg.id === segId,
        );
        const updatedSegment = {
          id: existingIndex >= 0 ? current.transcripts[existingIndex].id : segId,
          seqNo: payload.seqNo,
          startMs: payload.startMs,
          endMs: Math.max(payload.startMs + 250, payload.endMs),
          speakerId,
          speakerLabelRaw: rawLabel,
          confirmedText: payload.isFinal ? payload.text : "",
          unconfirmedText: payload.isFinal ? undefined : payload.text,
          live: !payload.isFinal,
        };

        const nextTranscripts =
          existingIndex >= 0
            ? current.transcripts.map((seg, idx) => (idx === existingIndex ? updatedSegment : seg))
            : [...current.transcripts, updatedSegment].sort((a, b) => a.startMs - b.startMs);

        return {
          ...current,
          durationMs: Math.max(current.durationMs, payload.endMs),
          participants: nextParticipants,
          transcripts: nextTranscripts,
        };
      });
    },
    Boolean(meetingId) && isTauri(),
  );

  const mutateMeeting = useCallback((updater: (current: Meeting) => Meeting) => {
    setMeeting((current) => (current ? updater(current) : current));
  }, []);

  return {
    meeting,
    loading,
    notFound,
    error,
    reload: load,
    mutateMeeting,
  };
}
