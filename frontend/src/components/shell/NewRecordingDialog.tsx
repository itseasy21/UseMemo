"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Camera,
  Check,
  Circle,
  Cpu,
  Loader2,
  Mic,
  MonitorSpeaker,
  ShieldCheck,
  Square,
  Users,
} from "lucide-react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import { Meter } from "@/components/ui/Meter";
import { Pill } from "@/components/ui/Pill";
import { Toggle } from "@/components/ui/Toggle";
import { BRAND } from "@/generated/brand";
import { useAudioLevels, useRecordingStopped } from "@/hooks/use-host-event";
import { DEMO_MODELS } from "@/lib/demo-data";
import { formatClock } from "@/lib/format";
import { createMeeting, startRecording, stopRecording } from "@/lib/host";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * System-audio loopback and diarization are contract-only in this build. The
 * toggles stay visible so the roadmap is discoverable, but they are disabled
 * and labelled rather than pretending to capture something they do not.
 */
const SYSTEM_AUDIO_AVAILABLE = false;
const DIARIZATION_AVAILABLE = false;

const SOURCES = [
  {
    id: "system",
    label: "System audio",
    detail: SYSTEM_AUDIO_AVAILABLE
      ? "ScreenCaptureKit loopback · 48 kHz"
      : "Not in this build · microphone only",
    icon: MonitorSpeaker,
    available: SYSTEM_AUDIO_AVAILABLE,
  },
  {
    id: "screenshots",
    label: "Periodic screenshots",
    detail: `${BRAND.features.defaultScreenshotIntervalSec}s cadence · dHash dedupe`,
    icon: Camera,
    available: true,
  },
  {
    id: "diarize",
    label: "Speaker diarization",
    detail: DIARIZATION_AVAILABLE
      ? "Voiceprints stay in the vault"
      : "Not in this build · single label per channel",
    icon: Users,
    available: DIARIZATION_AVAILABLE,
  },
] as const;

type SourceId = (typeof SOURCES)[number]["id"];

export function NewRecordingDialog() {
  const open = useWorkspaceStore((state) => state.newRecordingOpen);
  const close = useWorkspaceStore((state) => state.closeNewRecording);
  const pushToast = useWorkspaceStore((state) => state.pushToast);

  const [title, setTitle] = useState("");
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [noSignal, setNoSignal] = useState(false);
  const [sources, setSources] = useState<Record<SourceId, boolean>>({
    system: SYSTEM_AUDIO_AVAILABLE,
    screenshots: true,
    diarize: DIARIZATION_AVAILABLE,
  });
  const attemptRef = useRef(0);
  const peakMicRef = useRef(0);

  const installedAsr = useMemo(
    () =>
      DEMO_MODELS.find((model) => model.status === "installed" && model.role.includes("Speech")),
    [],
  );
  const installedSlm = useMemo(
    () =>
      DEMO_MODELS.find((model) => model.status === "installed" && model.role.includes("synthesis")),
    [],
  );

  useEffect(() => {
    if (!open) {
      setStarted(false);
      setStarting(false);
      setMeetingId(null);
      setElapsedMs(0);
      setNoSignal(false);
      peakMicRef.current = 0;
    }
  }, [open]);

  useEffect(() => {
    if (!started || !open) return;
    const timer = window.setInterval(() => setElapsedMs((value) => value + 1_000), 1_000);
    return () => window.clearInterval(timer);
  }, [open, started]);

  // In the browser preview the meter animates locally. Inside Tauri the
  // `audio:levels` host event drives it from the real capture thread.
  useEffect(() => {
    if (!started || !open || meetingId) return;
    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      setMicLevel(0.34 + Math.abs(Math.sin(frame * 0.72)) * 0.48);
    }, 140);
    return () => window.clearInterval(timer);
  }, [meetingId, open, started]);

  useAudioLevels(
    (payload) => {
      if (!meetingId || payload.meetingId !== meetingId) return;
      const level = Math.max(0, Math.min(1, (payload.rmsDbfs + 60) / 60));
      setMicLevel(level);
    },
    started && Boolean(meetingId),
  );

  useEffect(() => {
    if (micLevel > peakMicRef.current) peakMicRef.current = micLevel;
  }, [micLevel]);

  // A denied macOS microphone permission yields a running stream of silence
  // rather than an error, so the UI has to call it out explicitly.
  useEffect(() => {
    if (!started || !meetingId) {
      setNoSignal(false);
      return;
    }
    const timer = window.setTimeout(() => setNoSignal(peakMicRef.current < 0.02), 4_000);
    return () => window.clearTimeout(timer);
  }, [meetingId, started]);

  useRecordingStopped((payload) => {
    if (payload.error) {
      pushToast("Audio capture failed to finalize", payload.error, "danger");
      return;
    }
    if (payload.silent) {
      pushToast(
        "No microphone audio was captured",
        "Enable microphone access in System Settings → Privacy & Security, then record again.",
        "danger",
      );
    } else if (payload.droppedBlocks > 0) {
      pushToast(
        "The audio buffer overran",
        `${payload.droppedBlocks} blocks were dropped. The take may have small gaps.`,
        "accent",
      );
    }
  });

  const toggleSource = (source: SourceId) => {
    setSources((current) => ({ ...current, [source]: !current[source] }));
  };

  const start = () => {
    if (starting || started) return;
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setStarted(true);
    setElapsedMs(0);

    if (!isTauri()) return;
    setStarting(true);
    void (async () => {
      const meeting = await createMeeting({
        title: title.trim() || undefined,
        screenshotIntervalSec: sources.screenshots
          ? BRAND.features.defaultScreenshotIntervalSec
          : 0,
        asrModelId: installedAsr?.id,
        slmModelId: installedSlm?.id,
      });
      const recording = meeting ? await startRecording(meeting.id) : null;
      if (attemptRef.current !== attempt) {
        // The dialog was dismissed while the host was preparing the session.
        if (recording) await stopRecording(recording.id);
        return;
      }
      setStarting(false);
      if (!meeting || !recording) {
        setStarted(false);
        pushToast(
          "Could not start the local recording",
          "Check microphone and screen-capture permissions, then try again.",
          "danger",
        );
        return;
      }
      setMeetingId(recording.id);
    })();
  };

  const finish = (notify: boolean) => {
    attemptRef.current += 1;
    const activeMeeting = meetingId;
    setMeetingId(null);
    setStarting(false);
    close();
    if (activeMeeting) {
      void stopRecording(activeMeeting).then((meeting) => {
        if (!meeting && notify) {
          pushToast(
            "Session is still marked recording",
            "The host could not finalize it. Reopen the app to recover the session.",
            "danger",
          );
        }
      });
    }
    if (notify) {
      pushToast(
        "Recording saved locally",
        `${formatClock(elapsedMs)} · ${title.trim() || "Untitled local recording"} · written to the vault`,
        "success",
      );
    }
  };

  const stop = () => finish(true);
  const cancel = () => finish(started && Boolean(meetingId));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      title={started ? "Recording in progress" : "New local recording"}
      description={
        started
          ? "Audio is being captured inside this machine. Stop to write the session to SQLite."
          : "A capture session writes directly to the local vault. Nothing is uploaded."
      }
      size="lg"
      footer={
        <>
          <span className="flex items-center gap-1.5 text-[10px] text-text-muted">
            <ShieldCheck className="size-3 text-accent-primary" />
            Offline enforced
            <span className="text-border-subtle">·</span>
            {isTauri() ? "Tauri host" : "browser preview"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
            {started ? (
              <Button
                variant="danger"
                size="sm"
                leading={<Square className="size-3" />}
                onClick={stop}
                disabled={starting}
              >
                Stop &amp; save
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                leading={<Mic className="size-3.5" />}
                onClick={start}
                disabled={starting}
              >
                {starting ? "Preparing…" : "Start recording"}
                <Kbd className="ml-1 border-bg-primary/25 bg-bg-primary/15 text-bg-primary">⌘N</Kbd>
              </Button>
            )}
          </div>
        </>
      }
    >
      {started ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-6 rounded-brand border border-recording-pulse/25 bg-recording-pulse/[0.06] p-4">
            <div className="flex items-center gap-3">
              <span className="relative flex size-9 items-center justify-center rounded-full border border-recording-pulse/30 bg-recording-pulse/10">
                <span className="absolute inset-0 animate-ping rounded-full bg-recording-pulse/15" />
                <Circle className="relative size-3 fill-recording-pulse text-recording-pulse" />
              </span>
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {title.trim() || "Untitled local recording"}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
                  <Loader2 className="size-2.5 animate-spin" />
                  {starting ? "preparing local capture…" : `capturing · ${formatClock(elapsedMs)}`}
                </p>
              </div>
            </div>
            <div className="tabular text-2xl font-light tracking-[-0.03em] text-text-primary">
              {formatClock(elapsedMs)}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-brand border border-border-subtle bg-bg-primary/35 p-3">
              <div className="mb-2 flex items-center justify-between text-[10px] font-medium text-text-muted">
                <span className="flex items-center gap-1.5">
                  <Mic className="size-3 text-accent-primary" /> Mic · You
                </span>
                <span className="tabular">{Math.round(micLevel * 100)}%</span>
              </div>
              <Meter value={micLevel} label="Microphone input level" />
              {noSignal ? (
                <p className="mt-2 text-[10px] leading-4 text-amber-600 dark:text-amber-300">
                  No signal yet. Check System Settings → Privacy &amp; Security → Microphone.
                </p>
              ) : null}
            </div>
            <div className="rounded-brand border border-dashed border-border-subtle bg-bg-primary/20 p-3">
              <div className="mb-2 flex items-center justify-between text-[10px] font-medium text-text-muted">
                <span className="flex items-center gap-1.5">
                  <AudioLines className="size-3 text-accent-secondary" /> System · Remote
                </span>
                <span className="tabular">off</span>
              </div>
              <p className="text-[10px] leading-4 text-text-muted">
                System audio is not captured in this build. Put the call on speaker, or join from a
                second device.
              </p>
            </div>
          </div>

          <div className="rounded-brand border border-border-subtle bg-bg-primary/35 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
              <Pill tone="accent" icon={<Check className="size-2.5" />}>
                Microphone only
              </Pill>
              <Pill tone={sources.screenshots ? "secondary" : "outline"}>
                Screenshots{" "}
                {sources.screenshots ? `${BRAND.features.defaultScreenshotIntervalSec}s` : "off"}
              </Pill>
              <Pill tone={sources.diarize ? "success" : "outline"}>
                {sources.diarize ? "Diarizing" : "No diarization"}
              </Pill>
              <Pill tone="neutral">{installedAsr?.name ?? "Local ASR"}</Pill>
              <Pill tone="neutral">{installedSlm?.name ?? "Local SLM"}</Pill>
            </div>
            <p className="mt-2 text-[10.5px] leading-5 text-text-muted">
              Audio streams to a 16 kHz mono WAV in the vault while you record, and the header is
              patched on stop so an interrupted take stays playable. Screenshots are deduped before
              they are written.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label
              htmlFor="recording-title"
              className="mb-1.5 block text-[11px] font-medium text-text-muted"
            >
              Session title
            </label>
            <input
              id="recording-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Q3 launch readiness"
              autoFocus
              className="h-9 w-full rounded-brand border border-border-subtle bg-bg-primary/45 px-3 text-sm text-text-primary outline-none transition placeholder:text-text-muted/60 focus:border-accent-primary/50"
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { label: "ASR", model: installedAsr, icon: Mic },
              { label: "Synthesis", model: installedSlm, icon: Cpu },
            ].map(({ label, model, icon: Icon }) => (
              <div
                key={label}
                className="rounded-brand border border-border-subtle bg-bg-primary/35 p-3"
              >
                <p className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                  <Icon className="size-3" /> {label}
                </p>
                <p className="truncate text-xs font-medium text-text-primary">
                  {model?.name ?? "Model provisioning required"}
                </p>
                <p className="mt-0.5 truncate font-mono text-[9px] text-text-muted">
                  {model?.files[0]?.filename ?? "open Model Studio"}
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <Pill tone={model?.verified ? "success" : "warning"}>
                    {model?.verified ? "SHA-256 verified" : "Not installed"}
                  </Pill>
                  <Pill tone="outline">{model?.accelerator ?? "local"}</Pill>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            {SOURCES.map((source) => {
              const Icon = source.icon;
              return (
                <div
                  key={source.id}
                  className="flex items-center gap-3 rounded-brand border border-border-subtle bg-bg-primary/25 px-3 py-2.5"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] border border-border-subtle bg-bg-elevated text-text-muted">
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-text-primary">{source.label}</p>
                    <p className="truncate text-[10px] text-text-muted">{source.detail}</p>
                  </div>
                  {source.available ? (
                    <Toggle
                      checked={sources[source.id]}
                      onChange={() => toggleSource(source.id)}
                      label={`Toggle ${source.label}`}
                      size="sm"
                    />
                  ) : (
                    <Pill tone="outline">Planned</Pill>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 rounded-brand border border-dashed border-border-subtle bg-bg-primary/20 px-3 py-2 text-[10px] leading-4 text-text-muted">
            <Avatar name="Sarah Chen" tone="accent" size="xs" />
            <Avatar name="Alex Rivera" tone="secondary" size="xs" />
            <Avatar name="You" tone="violet" size="xs" />
            <span className="ml-1">
              Voiceprints enrolled for these speakers. Rename labels any time in the studio.
            </span>
          </div>
        </div>
      )}
    </Dialog>
  );
}
