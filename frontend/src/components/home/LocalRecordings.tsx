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
  processing: "Processing",
  completed: "Completed",
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
        "Transcription complete",
        `${outcome.segments} segments · ${outcome.modelId} · ${outcome.skippedBlocks} silent blocks skipped`,
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
    <section aria-labelledby="recordings-heading" className="panel overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div>
          <h2 id="recordings-heading" className="text-[12px] font-semibold text-text-primary">
            Local recordings
          </h2>
          <p className="mt-0.5 text-[9.5px] text-text-muted">
            {meetings === null
              ? "Reading the local vault…"
              : `${meetings.length} take${meetings.length === 1 ? "" : "s"} · SQLite + WAV on this device`}
          </p>
        </div>
        <Pill tone="accent" icon={<ShieldCheck className="size-2.5" />}>
          On-device ASR
        </Pill>
      </header>

      {meetings !== null && meetings.length === 0 ? (
        <div className="flex items-start gap-3 px-4 py-5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/40 text-text-muted">
            <Mic className="size-3.5" />
          </span>
          <div>
            <p className="text-[11px] font-medium text-text-primary">No recordings yet</p>
            <p className="mt-1 max-w-[460px] text-[10px] leading-5 text-text-muted">
              Start a session with New recording. Audio is written to a 16 kHz WAV in the vault and
              can be transcribed here once you stop.
            </p>
          </div>
        </div>
      ) : null}

      {meetings !== null && meetings.length > 0 ? (
        <div className="grid min-h-0 gap-0 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="max-h-[260px] overflow-y-auto border-b border-border-subtle lg:max-h-[320px] lg:border-b-0 lg:border-r">
            {meetings.map((meeting) => {
              const active = meeting.id === selectedId;
              return (
                <button
                  key={meeting.id}
                  type="button"
                  onClick={() => setSelectedId(meeting.id)}
                  className={cn(
                    "flex w-full items-start gap-2 border-b border-border-subtle/70 px-3 py-2.5 text-left transition last:border-b-0",
                    active
                      ? "bg-accent-primary/[0.055] text-text-primary"
                      : "text-text-muted hover:bg-bg-elevated/40 hover:text-text-primary",
                  )}
                >
                  <span
                    className={cn(
                      "mt-1 size-1.5 shrink-0 rounded-full",
                      meeting.status === "recording"
                        ? "bg-recording-pulse"
                        : active
                          ? "bg-accent-primary"
                          : "bg-border-subtle",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10.5px] font-medium">
                      {meeting.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[8.5px] text-text-muted">
                      <span>{STATUS_LABEL[meeting.status] ?? meeting.status}</span>
                      <span className="text-border-subtle">·</span>
                      <span className="tabular">
                        {formatTimestamp(Math.max(0, meeting.durationMs))}
                      </span>
                      {meeting.audioFilePath ? (
                        <>
                          <span className="text-border-subtle">·</span>
                          <AudioLines className="size-2.5 text-accent-primary/70" />
                        </>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="min-w-0 p-3.5">
            {selected ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 truncate text-[11.5px] font-medium text-text-primary">
                    {selected.title}
                  </h3>
                  <span className="text-[9px] text-text-muted">
                    {new Date(selected.createdAt).toLocaleString()}
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    className="ml-auto gap-1.5"
                    onClick={() => void transcribe()}
                    disabled={!canTranscribe}
                    leading={
                      transcribing ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <AudioLines className="size-3" />
                      )
                    }
                  >
                    {transcribing
                      ? progress
                        ? `Transcribing · ${Math.round(progress.percent)}%`
                        : "Transcribing…"
                      : "Transcribe"}
                  </Button>
                </div>

                {!selected.audioFilePath ? (
                  <p className="mt-2 text-[9.5px] leading-4 text-text-muted">
                    This take has no saved audio, so there is nothing to transcribe.
                  </p>
                ) : null}
                {error ? (
                  <p className="mt-2 rounded-brand border border-recording-pulse/25 bg-recording-pulse/[0.06] px-2 py-1.5 text-[9.5px] leading-4 text-recording-pulse">
                    {error}
                  </p>
                ) : null}

                <div className="mt-2 max-h-[220px] overflow-y-auto rounded-brand border border-border-subtle/70 bg-bg-primary/25 px-2.5 py-2">
                  {segments === null ? (
                    <p className="py-2 text-[9.5px] text-text-muted">Reading transcript…</p>
                  ) : segments.length === 0 ? (
                    <p className="py-2 text-[9.5px] leading-4 text-text-muted">
                      No transcript yet. Install an ASR model in Model Studio, then run Transcribe
                      on this take.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {segments.map((segment) => (
                        <div key={segment.id} className="flex gap-2 text-[10px] leading-4">
                          <span className="tabular w-10 shrink-0 pt-px text-[8.5px] text-text-muted">
                            {formatTimestamp(segment.startMs)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="mr-1.5 text-[8.5px] font-medium uppercase tracking-[0.06em] text-accent-primary/80">
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
              <p className="text-[10px] text-text-muted">Select a recording to inspect it.</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
