"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Camera,
  EyeOff,
  Mic,
  Mic2,
  NotebookPen,
  Pause,
  Play,
  ShieldCheck,
  Square,
  Volume2,
  X,
} from "lucide-react";

import {
  useAudioLevels,
  useHostEvent,
  useMeetingChanged,
  useRecordingStopped,
} from "@/hooks/use-host-event";
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
  setCallDetectionAppEnabled,
  stopRecording,
} from "@/lib/host";
import { isImeComposing } from "@/lib/ime";
import { HOST_EVENTS, isTauri, type CallDetectedPayload } from "@/lib/tauri";

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
  const [detected, setDetected] = useState<CallDetectedPayload | null>(null);

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

  const resizeHud = useCallback(async (expanded: boolean) => {
    if (!isTauri()) return;
    try {
      const { LogicalSize, getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setSize(new LogicalSize(expanded ? 360 : 320, expanded ? 180 : 48));
    } catch {
      // Keep the current HUD size when the window API is unavailable.
    }
  }, []);

  useHostEvent(HOST_EVENTS.callDetected, (payload) => {
    if (active) return;
    setDetected(payload);
    void resizeHud(true);
  });

  useHostEvent(HOST_EVENTS.callEnded, (payload) => {
    setDetected((current) => {
      if (current?.callId !== payload.callId) return current;
      void resizeHud(false);
      void hideHud();
      return null;
    });
  });

  useHostEvent(HOST_EVENTS.callDismissed, (payload) => {
    setDetected((current) => {
      if (payload.callId !== null && current?.callId !== payload.callId) return current;
      void resizeHud(false);
      void hideHud();
      return null;
    });
  });

  useEffect(() => {
    if (active) {
      setDetected(null);
      void resizeHud(false);
    }
  }, [active, resizeHud]);

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

  const dismissDetected = async () => {
    const callId = detected?.callId ?? null;
    setDetected(null);
    if (isTauri()) {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(HOST_EVENTS.callDismissed, { callId });
    }
    await resizeHud(false);
    await hideHud();
  };

  const acceptDetected = async () => {
    if (!detected) return;
    if (isTauri()) {
      try {
        const [{ emit }, { WebviewWindow }] = await Promise.all([
          import("@tauri-apps/api/event"),
          import("@tauri-apps/api/webviewWindow"),
        ]);
        const main = await WebviewWindow.getByLabel("main");
        await main?.show();
        await main?.setFocus();
        await emit(HOST_EVENTS.callAccepted, detected);
      } catch {
        // The main window remains available from the tray if activation fails.
      }
    }
    await dismissDetected();
  };

  if (detected && !active) {
    return (
      <main className="flex h-dvh w-screen items-center justify-center bg-transparent p-1.5">
        <section className="glass relative flex h-full w-full flex-col rounded-2xl border border-border-subtle/70 p-4 shadow-lg">
          <button
            type="button"
            aria-label="Dismiss call prompt"
            onClick={() => void dismissDetected()}
            className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-lg text-text-muted hover:bg-bg-elevated hover:text-text-primary"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
          <div data-tauri-drag-region className="flex cursor-grab items-start gap-3 pr-8">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary/15 text-accent-primary">
              <Mic2 className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">
                {detected.confidence >= 0.8
                  ? `${detected.appName} call detected`
                  : `${detected.appName} is using your microphone`}
              </p>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                Start a private local recording? Tell everyone first.
              </p>
            </div>
          </div>
          <div className="mt-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void acceptDetected()}
              className="h-8 rounded-xl bg-accent-primary px-3 text-xs font-semibold text-bg-primary"
            >
              Start recording
            </button>
            <button
              type="button"
              onClick={() => void dismissDetected()}
              className="h-8 rounded-xl px-3 text-xs font-medium text-text-muted hover:bg-bg-elevated hover:text-text-primary"
            >
              Not now
            </button>
            <button
              type="button"
              onClick={() => {
                void setCallDetectionAppEnabled(detected.appId, false);
                void dismissDetected();
              }}
              className="ml-auto inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary"
            >
              <ShieldCheck className="size-3" aria-hidden="true" />
              Never
            </button>
          </div>
        </section>
      </main>
    );
  }

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
