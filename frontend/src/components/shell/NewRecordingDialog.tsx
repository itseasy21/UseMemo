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
import {
  configureAudioSession,
  createMeeting,
  deactivateAudioSession,
  getAudioCapabilities,
  requestMicrophonePermission,
  startRecording,
  stopRecording,
} from "@/lib/host";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * The microphone is always "You". The loopback is diarized after the take:
 * voices become "Speaker N" when the on-device clustering separates them and
 * fall back to "Them" otherwise. System audio is enabled from the host's
 * capability probe rather than a hardcoded platform list.
 */
const DIARIZATION_AVAILABLE = true;

type SourceId = "system" | "screenshots" | "diarize";

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
  const [systemLevel, setSystemLevel] = useState(0);
  const [noSignal, setNoSignal] = useState(false);
  const [capabilities, setCapabilities] = useState<Awaited<
    ReturnType<typeof getAudioCapabilities>
  > | null>(null);
  const [sources, setSources] = useState<Record<SourceId, boolean>>({
    system: false,
    screenshots: true,
    diarize: DIARIZATION_AVAILABLE,
  });
  const attemptRef = useRef(0);
  const peakMicRef = useRef(0);

  const systemAvailable = capabilities?.systemAudio ?? false;

  useEffect(() => {
    if (!open || !isTauri()) return;
    let cancelled = false;
    void getAudioCapabilities().then((next) => {
      if (!cancelled) setCapabilities(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSources((current) =>
      current.system && !systemAvailable ? { ...current, system: false } : current,
    );
  }, [open, systemAvailable]);

  const sourcesConfig = useMemo(
    () =>
      [
        {
          id: "system" as const,
          label: "System audio",
          detail: systemAvailable
            ? capabilities?.systemBackend === "wasapi"
              ? "WASAPI loopback · 48 kHz · second archive"
              : "ScreenCaptureKit loopback · 48 kHz · second archive"
            : isTauri()
              ? "Unavailable on this platform · microphone only"
              : "Tauri host only · microphone in browser preview",
          icon: MonitorSpeaker,
          available: systemAvailable,
        },
        {
          id: "screenshots" as const,
          label: "Periodic screenshots",
          detail: `${BRAND.features.defaultScreenshotIntervalSec}s cadence · dHash dedupe`,
          icon: Camera,
          available: true,
        },
        {
          id: "diarize" as const,
          label: "Speaker diarization",
          detail: "On-device acoustic clustering · no model download",
          icon: Users,
          available: DIARIZATION_AVAILABLE,
        },
      ] as const,
    [capabilities?.systemBackend, systemAvailable],
  );

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
      setMicLevel(0);
      setSystemLevel(0);
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
      if (payload.channel === "system") {
        setSystemLevel(level);
      } else {
        setMicLevel(level);
      }
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
    if (payload.systemError) {
      pushToast("System audio stopped early", payload.systemError, "accent");
    } else if (payload.system?.error) {
      pushToast("System audio stopped early", payload.system.error, "accent");
    } else if (payload.system?.silent) {
      pushToast(
        "No system audio was captured",
        "Nothing was playing during the take, or Screen Recording permission is missing.",
        "accent",
      );
    } else if (payload.system && payload.system.droppedBlocks > 0) {
      pushToast(
        "The system-audio buffer overran",
        `${payload.system.droppedBlocks} loopback blocks were dropped. The remote channel may have gaps.`,
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
      // Asking before the meeting row exists keeps a denied prompt from
      // leaving an empty take in the vault. Desktop reports granted here; the
      // OS prompt happens inside the capture backend.
      const permission = await requestMicrophonePermission();
      if (permission !== "granted") {
        if (attemptRef.current === attempt) {
          setStarting(false);
          setStarted(false);
          pushToast(
            "Microphone access is off",
            "Allow microphone access in your device settings, then record again.",
            "danger",
          );
        }
        return;
      }
      const session = await configureAudioSession();
      if (!session?.configured) {
        if (attemptRef.current === attempt) {
          setStarting(false);
          setStarted(false);
          pushToast(
            "Could not prepare the audio session",
            "Close other audio apps or check the system audio settings, then try again.",
            "danger",
          );
        }
        return;
      }

      const meeting = await createMeeting({
        title: title.trim() || undefined,
        screenshotIntervalSec: sources.screenshots
          ? BRAND.features.defaultScreenshotIntervalSec
          : 0,
        asrModelId: installedAsr?.id,
        slmModelId: installedSlm?.id,
        diarization: sources.diarize,
      });
      const recording = meeting
        ? await startRecording(meeting.id, { captureSystemAudio: sources.system })
        : null;
      if (attemptRef.current !== attempt) {
        // The dialog was dismissed while the host was preparing the session.
        if (recording) await stopRecording(recording.id);
        void deactivateAudioSession();
        return;
      }
      setStarting(false);
      if (!meeting || !recording) {
        setStarted(false);
        void deactivateAudioSession();
        pushToast(
          "Could not start the local recording",
          sources.system
            ? "Check microphone permission and Screen Recording permission, then try again."
            : "Check microphone permission, then try again.",
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
      void stopRecording(activeMeeting)
        .then((meeting) => {
          if (!meeting && notify) {
            pushToast(
              "Session is still marked recording",
              "The host could not finalize it. Reopen the app to recover the session.",
              "danger",
            );
          }
        })
        .finally(() => {
          void deactivateAudioSession();
        });
    } else {
      void deactivateAudioSession();
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
            <div
              className={cn(
                "rounded-brand border p-3",
                sources.system
                  ? "border-border-subtle bg-bg-primary/35"
                  : "border-dashed border-border-subtle bg-bg-primary/20",
              )}
            >
              <div className="mb-2 flex items-center justify-between text-[10px] font-medium text-text-muted">
                <span className="flex items-center gap-1.5">
                  <AudioLines className="size-3 text-accent-secondary" /> System · Them
                </span>
                <span className="tabular">
                  {sources.system ? `${Math.round(systemLevel * 100)}%` : "off"}
                </span>
              </div>
              {sources.system ? (
                <>
                  <Meter value={systemLevel} label="System audio level" />
                  <p className="mt-2 text-[10px] leading-4 text-text-muted">
                    Use headphones. Echo cancellation is off, so the microphone can also hear your
                    speakers.
                  </p>
                </>
              ) : (
                <p className="text-[10px] leading-4 text-text-muted">
                  {systemAvailable
                    ? "Loopback is off for this take. Enable it before recording to capture the remote side."
                    : "System audio is unavailable here. Put the call on speaker, or join from a second device."}
                </p>
              )}
            </div>
          </div>

          <div className="rounded-brand border border-border-subtle bg-bg-primary/35 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
              <Pill tone="accent" icon={<Check className="size-2.5" />}>
                {sources.system ? "Mic + system" : "Microphone only"}
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
              {sources.system
                ? "Two independent 16 kHz mono WAVs are written to the vault: the microphone is labelled You, the loopback is kept on its own track. "
                : "The microphone streams to a 16 kHz mono WAV in the vault while you record. "}
              Headers are patched on stop so an interrupted take stays playable, and screenshots are
              deduped before they are written.
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
            {sourcesConfig.map((source) => {
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

          {capabilities?.note ? (
            <p className="px-1 text-[10px] leading-4 text-text-muted">{capabilities.note}</p>
          ) : null}

          <div className="flex items-center gap-2 rounded-brand border border-dashed border-border-subtle bg-bg-primary/20 px-3 py-2 text-[10px] leading-4 text-text-muted">
            <Mic className="size-3 shrink-0 text-accent-primary" />
            <span>
              Microphone segments are labelled “You”. Loopback speech is split into Speaker 1,
              Speaker 2… when voices are acoustically separable; short or overlapping speech stays
              “Them” rather than guessing an identity.
            </span>
          </div>
        </div>
      )}
    </Dialog>
  );
}
