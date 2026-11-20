"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera, EyeOff, Mic, NotebookPen, Pause, Play, Square, Volume2 } from "lucide-react";

import { useAudioLevels, useMeetingChanged, useRecordingStopped } from "@/hooks/use-host-event";
import { formatClock } from "@/lib/format";
import {
  captureScreenshot,
  deactivateAudioSession,
  getMeeting,
  listNotes,
  pauseRecording,
  recordingStatus,
  resumeRecording,
  saveNotes,
  stopRecording,
} from "@/lib/host";
import { isImeComposing } from "@/lib/ime";
import { isTauri } from "@/lib/tauri";

type HudMeeting = { id: string; title: string };

const DEMO_MEETING: HudMeeting = { id: "demo-q3-launch", title: "Q3 launch readiness" };

function levelFromDbfs(dbfs: number): number {
  return Math.max(0.04, Math.min(1, (dbfs + 60) / 60));
}

export default function HudPage() {
  const [meeting, setMeeting] = useState<HudMeeting | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [level, setLevel] = useState(0.14);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  const flash = (msg: string) => {
    setFlashMessage(msg);
    window.setTimeout(() => {
      setFlashMessage((curr) => (curr === msg ? null : curr));
    }, 1_800);
  };

  const syncFromHost = useCallback(async () => {
    if (!isTauri()) {
      setPreview(true);
      setMeeting(DEMO_MEETING);
      setStartedAt((curr) => curr ?? Date.now() - 12 * 60_000 - 4_000);
      return;
    }
    const snapshot = await recordingStatus();
    if (!snapshot) {
      setMeeting(null);
      setStartedAt(null);
      setPaused(false);
      return;
    }
    setStartedAt(snapshot.startedAtMs);
    setPaused(Boolean(snapshot.paused));
    try {
      const active = await getMeeting(snapshot.meetingId);
      setMeeting(
        active
          ? { id: active.id, title: active.title }
          : { id: snapshot.meetingId, title: "Active recording" },
      );
    } catch {
      setMeeting({ id: snapshot.meetingId, title: "Active recording" });
    }
  }, []);

  useEffect(() => {
    setNow(Date.now());
    void syncFromHost();
    if (!isTauri()) return;

    const onFocus = () => void syncFromHost();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void syncFromHost();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [syncFromHost]);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  useMeetingChanged((payload) => {
    if (payload.meeting.status === "recording") {
      setMeeting({ id: payload.meeting.id, title: payload.meeting.title });
      void recordingStatus().then((snap) => {
        if (snap && snap.meetingId === payload.meeting.id) {
          setStartedAt(snap.startedAtMs);
        } else {
          setStartedAt((curr) => curr ?? Date.now());
        }
      });
      return;
    }
    if (payload.meeting.id === meeting?.id) {
      setMeeting(null);
      setStartedAt(null);
    }
  });

  useRecordingStopped((payload) => {
    if (!meeting || payload.meetingId === meeting.id) {
      setMeeting(null);
      setStartedAt(null);
      setLevel(0.06);
    }
  });

  useAudioLevels(
    (payload) => setLevel(levelFromDbfs(payload.rmsDbfs)),
    Boolean(meeting) && isTauri(),
  );

  const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt);
  const active = startedAt !== null && Boolean(meeting);

  const stop = async () => {
    if (busy) return;
    if (preview || !meeting) {
      setMeeting(null);
      setStartedAt(null);
      setPreview(false);
      return;
    }
    setBusy(true);
    try {
      await stopRecording(meeting.id);
      await deactivateAudioSession();
      setMeeting(null);
      setStartedAt(null);
      flash("Saved");
    } catch {
      flash("Error");
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    if (!meeting || busy) return;
    if (!isTauri()) {
      setPaused((prev) => !prev);
      return;
    }
    try {
      const next = paused ? await resumeRecording(meeting.id) : await pauseRecording(meeting.id);
      if (next) {
        setPaused(Boolean(next.paused));
        flash(next.paused ? "Paused" : "Resumed");
      }
    } catch {
      flash("Error");
    }
  };

  const snapSlide = async () => {
    if (!meeting || busy) return;
    if (!isTauri()) {
      flash("Snapped");
      return;
    }
    try {
      const outcome = await captureScreenshot(meeting.id);
      flash(outcome?.deduplicated ? "Unchanged" : "Slide saved");
    } catch {
      flash("Snap failed");
    }
  };

  const submitQuickNote = async () => {
    const trimmed = noteDraft.trim();
    if (!trimmed || !meeting) {
      setNoteOpen(false);
      return;
    }
    setNoteDraft("");
    setNoteOpen(false);
    if (!isTauri()) {
      flash("Note added");
      return;
    }
    try {
      const existing = (await listNotes(meeting.id)) ?? [];
      const nextBlocks = [
        ...existing.map((b) => ({
          lineIndex: b.lineIndex,
          blockType: b.blockType,
          contentMd: b.contentMd,
          recordingOffsetMs: b.recordingOffsetMs,
          linkedScreenshotId: b.linkedScreenshotId,
        })),
        {
          lineIndex: existing.length + 1,
          blockType: "paragraph",
          contentMd: trimmed,
          recordingOffsetMs: elapsed,
        },
      ];
      const rawMd = nextBlocks.map((b) => b.contentMd).join("\n\n");
      await saveNotes({ meetingId: meeting.id, rawMd, blocks: nextBlocks });
      flash("Note saved");
    } catch {
      flash("Save failed");
    }
  };

  const hideHud = async () => {
    if (!isTauri()) {
      window.close();
      return;
    }
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch {
      // Ignore if window hide permission is unavailable.
    }
  };

  return (
    <main className="flex h-dvh w-screen items-center justify-center bg-transparent p-1.5">
      <div
        className="glass flex h-12 w-full items-center gap-2 rounded-full border border-border-subtle/70 px-2.5 shadow-lg"
        aria-label={`${meeting?.title ?? "Recording"} HUD`}
      >
        <span data-tauri-drag-region className="flex shrink-0 cursor-grab items-center gap-2">
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

        {noteOpen ? (
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (isImeComposing(e)) return;
                void submitQuickNote();
              } else if (e.key === "Escape") {
                setNoteOpen(false);
              }
            }}
            placeholder="Quick timestamped note…"
            aria-label="Quick timestamped note"
            autoFocus
            className="h-7 min-w-0 flex-1 rounded-full border border-accent-primary/45 bg-bg-primary/70 px-2.5 text-[11px] text-text-primary outline-none"
          />
        ) : (
          <span
            data-tauri-drag-region
            className="min-w-0 flex-1 cursor-grab truncate text-[11px] text-text-muted"
            title={meeting?.title}
          >
            {flashMessage ?? meeting?.title ?? "No active recording"}
          </span>
        )}

        {!noteOpen && (
          <span className="hidden shrink-0 items-end gap-[2px] sm:flex" aria-hidden="true">
            {[0.45, 0.8, 1, 0.7, 0.35].map((weight, index) => (
              <span
                key={index}
                className="w-[2px] rounded-full bg-accent-primary/80 transition-[height] duration-150"
                style={{ height: `${4 + (active ? level : 0.08) * weight * 13}px` }}
              />
            ))}
          </span>
        )}

        {!noteOpen && (
          <span
            className="hidden shrink-0 items-center gap-1 text-[10px] text-text-muted/70 sm:flex"
            aria-hidden="true"
          >
            <Mic className="size-3" />
            <Volume2 className="size-3" />
          </span>
        )}

        <button
          type="button"
          onClick={() => setNoteOpen((prev) => !prev)}
          disabled={!active}
          aria-label="Add timestamped note"
          title="Quick note"
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/45 text-text-muted transition hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        >
          <NotebookPen className="size-3" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => void snapSlide()}
          disabled={!active || busy}
          aria-label="Capture slide screenshot"
          title="Capture slide"
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/45 text-text-muted transition hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        >
          <Camera className="size-3" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => void togglePause()}
          disabled={!active || busy}
          aria-label={paused ? "Resume recording" : "Pause recording"}
          title={paused ? "Resume" : "Pause"}
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/45 text-text-muted transition hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
        >
          {paused ? (
            <Play className="size-2.5 fill-current" aria-hidden="true" />
          ) : (
            <Pause className="size-2.5" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={() => void stop()}
          disabled={!active || busy}
          aria-label={active ? "Stop recording" : "No active recording"}
          title="Stop recording"
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-recording-pulse/30 bg-recording-pulse/10 text-recording-pulse transition hover:bg-recording-pulse/20 disabled:pointer-events-none disabled:opacity-35"
        >
          <Square className="size-2.5 fill-current" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => void hideHud()}
          aria-label="Hide floating recorder"
          title="Hide HUD"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-text-muted/75 transition hover:bg-bg-elevated hover:text-text-primary"
        >
          <EyeOff className="size-3" aria-hidden="true" />
        </button>
      </div>
    </main>
  );
}
