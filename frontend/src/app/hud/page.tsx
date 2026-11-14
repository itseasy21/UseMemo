"use client";

import { useEffect, useState } from "react";
import { Mic, Square, Volume2 } from "lucide-react";

import { useAudioLevels, useMeetingChanged } from "@/hooks/use-host-event";
import { formatClock } from "@/lib/format";
import { getMeeting, recordingStatus, stopRecording } from "@/lib/host";
import { isTauri } from "@/lib/tauri";

type HudMeeting = { id: string; title: string };

const DEMO_MEETING: HudMeeting = { id: "demo-q3-launch", title: "Q3 launch readiness" };

function levelFromDbfs(dbfs: number): number {
  return Math.max(0.04, Math.min(1, (dbfs + 60) / 60));
}

export default function HudPage() {
  const [meeting, setMeeting] = useState<HudMeeting | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [level, setLevel] = useState(0.18);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    setNow(Date.now());
    if (!isTauri()) {
      setPreview(true);
      setMeeting(DEMO_MEETING);
      setStartedAt(Date.now() - 12 * 60_000 - 4_000);
      return;
    }
    void (async () => {
      const snapshot = await recordingStatus();
      if (!snapshot) return;
      const active = await getMeeting(snapshot.meetingId);
      setStartedAt(snapshot.startedAtMs);
      setMeeting(
        active
          ? { id: active.id, title: active.title }
          : { id: snapshot.meetingId, title: "Recording" },
      );
    })();
  }, []);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  useMeetingChanged((payload) => {
    if (payload.meeting.status === "recording") {
      setMeeting({ id: payload.meeting.id, title: payload.meeting.title });
      return;
    }
    if (payload.meeting.id === meeting?.id) {
      setMeeting(null);
      setStartedAt(null);
    }
  });

  useAudioLevels(
    (payload) => setLevel(levelFromDbfs(payload.rmsDbfs)),
    Boolean(meeting) && isTauri(),
  );

  const stop = () => {
    if (busy) return;
    if (preview || !meeting) {
      setMeeting(null);
      setStartedAt(null);
      setPreview(false);
      return;
    }
    setBusy(true);
    void stopRecording(meeting.id).then((finished) => {
      setBusy(false);
      if (!finished) return;
      setMeeting(null);
      setStartedAt(null);
    });
  };

  const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt);
  const active = startedAt !== null;

  return (
    <main className="flex h-dvh w-screen items-center justify-center bg-transparent p-1.5">
      <div
        className="glass flex h-12 w-full items-center gap-2.5 rounded-full border border-border-subtle/70 px-2.5 shadow-lg"
        aria-label={`${meeting?.title ?? "Recording"} HUD`}
      >
        <span data-tauri-drag-region className="flex shrink-0 items-center gap-2">
          <span className="relative flex size-2.5">
            {active && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-recording-pulse opacity-60" />
            )}
            <span
              className={
                active
                  ? "relative inline-flex size-2.5 rounded-full bg-recording-pulse"
                  : "relative inline-flex size-2.5 rounded-full bg-text-muted/40"
              }
            />
          </span>
          <span className="tabular text-[13px] font-medium tracking-[-0.02em] text-text-primary">
            {formatClock(elapsed)}
          </span>
        </span>

        <span
          data-tauri-drag-region
          className="min-w-0 flex-1 truncate text-[10px] text-text-muted"
          title={meeting?.title}
        >
          {meeting?.title ?? "No active recording"}
        </span>

        <span className="hidden shrink-0 items-end gap-[2px] sm:flex" aria-hidden="true">
          {[0.45, 0.8, 1, 0.7, 0.35].map((weight, index) => (
            <span
              key={index}
              className="w-[2px] rounded-full bg-accent-primary/80 transition-[height] duration-150"
              style={{ height: `${4 + level * weight * 13}px` }}
            />
          ))}
        </span>

        <span className="hidden shrink-0 items-center gap-1 text-[8px] text-text-muted/70 sm:flex">
          <Mic className="size-2.5" />
          <Volume2 className="size-2.5" />
        </span>

        <button
          type="button"
          onClick={stop}
          disabled={!active || busy}
          aria-label={active ? "Stop recording" : "No active recording"}
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-recording-pulse/30 bg-recording-pulse/10 text-recording-pulse transition hover:bg-recording-pulse/20 disabled:pointer-events-none disabled:opacity-40"
        >
          <Square className="size-2.5 fill-current" />
        </button>
      </div>
    </main>
  );
}
