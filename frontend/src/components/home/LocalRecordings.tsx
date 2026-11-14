"use client";

import { useCallback, useEffect, useState } from "react";
import { AudioLines, Loader2, Mic, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { useAsrProgress, useMeetingChanged, useRecordingStopped } from "@/hooks/use-host-event";
import { formatTimestamp } from "@/lib/format";
import {
  listMeetings,
  listTranscript,
  transcribeMeeting,
  type MeetingRecord,
  type TranscriptSegmentRecord,
} from "@/lib/host";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

const STATUS_LABEL: Record<string, string> = {
  recording: "Recording",
  processing: "Transcribing",
  completed: "Ready",
};

/**
 * The demo vault is static. Real takes live in SQLite, so they need their own
 * surface: list what the host actually recorded, show its transcript, and let
 * the user run the on-device recognizer over the saved audio.
 *
 * Renders nothing in a browser preview, where there is no host database.
 */
export function LocalRecordings() {
  const [hosted, setHosted] = useState(false);
  const [meetings, setMeetings] = useState<MeetingRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegmentRecord[] | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [progress, setProgress] = useState<{ percent: number; stage: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pushToast = useWorkspaceStore((state) => state.pushToast);

  useEffect(() => setHosted(isTauri()), []);

  const refreshMeetings = useCallback(async () => {
    if (!isTauri()) return;
    const rows = await listMeetings();
    if (rows) {
      setMeetings(rows);
      setSelectedId((current) => current ?? rows[0]?.id ?? null);
    }
  }, []);

  useEffect(() => {
    if (!hosted) return;
    void refreshMeetings();
  }, [hosted, refreshMeetings]);

  const refreshTranscript = useCallback(async (meetingId: string) => {
    const rows = await listTranscript(meetingId);
    setSegments(rows ?? []);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSegments(null);
      return;
    }
    setError(null);
    void refreshTranscript(selectedId);
  }, [refreshTranscript, selectedId]);

  useRecordingStopped((payload) => {
    void refreshMeetings();
    setSelectedId(payload.meetingId);
  });

  useMeetingChanged(() => {
    void refreshMeetings();
  });

  useAsrProgress((payload) => {
    if (payload.meetingId !== selectedId) return;
    setProgress({ percent: payload.percent, stage: payload.stage });
  });

  if (!hosted) return null;

  const selected = meetings?.find((meeting) => meeting.id === selectedId) ?? null;
  const canTranscribe = Boolean(selected) && Boolean(selected?.audioFilePath) && !transcribing;

  const transcribe = async () => {
    if (!selected || transcribing) return;
    setTranscribing(true);
    setProgress({ percent: 0, stage: "loading" });
    setError(null);
    try {
      const outcome = await transcribeMeeting(selected.id);
      await refreshTranscript(selected.id);
      await refreshMeetings();
      pushToast(
        "Transcription ready",
        `${outcome.segments} segments · ${outcome.speakerCount} ${
          outcome.speakerCount === 1 ? "speaker" : "speakers"
        }`,
        "success",
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      pushToast("Transcription failed", message, "danger");
    } finally {
      setTranscribing(false);
      setProgress(null);
    }
  };

  return (
    <section
      id="local-recordings"
      aria-labelledby="recordings-heading"
      className="panel mt-8 scroll-mt-8 overflow-hidden"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div>
          <h2
            id="recordings-heading"
            className="text-[18px] font-semibold tracking-[-0.02em] text-text-primary"
          >
            Recent recordings
          </h2>
          <p className="mt-1 text-[12px] text-text-muted">
            {meetings === null
              ? "Looking for recordings…"
              : meetings.length === 0
                ? "Your recordings will appear here."
                : `${meetings.length} ${meetings.length === 1 ? "recording" : "recordings"} on this Mac`}
          </p>
        </div>
        <Pill tone="accent" className="text-[11px]" icon={<ShieldCheck className="size-3" />}>
          On-device
        </Pill>
      </header>

      {meetings !== null && meetings.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full border border-accent-primary/20 bg-accent-primary/[0.06] text-accent-primary">
            <Mic className="size-5" />
          </span>
          <p className="mt-3 text-[14px] font-medium text-text-primary">No recordings yet</p>
          <p className="mt-1 max-w-[420px] text-[12.5px] leading-5 text-text-muted">
            Start a recording above and it will appear here. You can read the transcript or
            transcribe it whenever you&apos;re ready.
          </p>
        </div>
      ) : null}

      {meetings !== null && meetings.length > 0 ? (
        <div className="grid min-h-0 gap-0 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="max-h-[280px] overflow-y-auto border-b border-border-subtle lg:max-h-[340px] lg:border-b-0 lg:border-r">
            {meetings.map((meeting) => {
              const active = meeting.id === selectedId;
              return (
                <button
                  key={meeting.id}
                  type="button"
                  onClick={() => setSelectedId(meeting.id)}
                  className={cn(
                    "flex w-full items-start gap-2.5 border-b border-border-subtle/70 px-4 py-3 text-left transition last:border-b-0",
                    active
                      ? "bg-accent-primary/[0.055] text-text-primary"
                      : "text-text-muted hover:bg-bg-elevated/40 hover:text-text-primary",
                  )}
                >
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      meeting.status === "recording"
                        ? "bg-recording-pulse"
                        : active
                          ? "bg-accent-primary"
                          : "bg-border-subtle",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{meeting.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
                      <span>{STATUS_LABEL[meeting.status] ?? meeting.status}</span>
                      <span className="text-border-subtle">·</span>
                      <span className="tabular">
                        {formatTimestamp(Math.max(0, meeting.durationMs))}
                      </span>
                      {meeting.audioFilePath ? (
                        <>
                          <span className="text-border-subtle">·</span>
                          <AudioLines className="size-3 text-accent-primary/70" />
                        </>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="min-w-0 p-4 sm:p-5">
            {selected ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 truncate text-[16px] font-semibold tracking-[-0.015em] text-text-primary">
                    {selected.title}
                  </h3>
                  <span className="text-[11.5px] text-text-muted">
                    {new Date(selected.createdAt).toLocaleString()}
                  </span>
                  <Button
                    variant="primary"
                    size="md"
                    className="ml-auto gap-1.5"
                    onClick={() => void transcribe()}
                    disabled={!canTranscribe}
                    leading={
                      transcribing ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <AudioLines className="size-3.5" />
                      )
                    }
                  >
                    {transcribing
                      ? progress
                        ? `Transcribing ${Math.round(progress.percent)}%`
                        : "Transcribing…"
                      : "Transcribe"}
                  </Button>
                </div>

                {!selected.audioFilePath ? (
                  <p className="mt-2 text-[12px] leading-5 text-text-muted">
                    This recording has no saved audio, so there is nothing to transcribe.
                  </p>
                ) : null}
                {error ? (
                  <p className="mt-2 rounded-brand border border-recording-pulse/25 bg-recording-pulse/[0.06] px-3 py-2 text-[12px] leading-5 text-recording-pulse">
                    {error}
                  </p>
                ) : null}

                <div className="mt-3 max-h-[240px] overflow-y-auto rounded-brand border border-border-subtle/70 bg-bg-primary/25 px-3 py-2.5">
                  {segments === null ? (
                    <p className="py-2 text-[12px] text-text-muted">Loading transcript…</p>
                  ) : segments.length === 0 ? (
                    <p className="py-2 text-[12.5px] leading-5 text-text-muted">
                      No transcript yet. Open AI models to install one, then transcribe this
                      recording.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {segments.map((segment) => (
                        <div key={segment.id} className="flex gap-2.5 text-[12.5px] leading-5">
                          <span className="tabular w-11 shrink-0 pt-0.5 text-[10.5px] text-text-muted">
                            {formatTimestamp(segment.startMs)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="mr-1.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-accent-primary/80">
                              {segment.speakerLabel}
                            </span>
                            <span className="text-text-primary/90">{segment.text}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-text-muted">
                Select a recording to read its transcript.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
