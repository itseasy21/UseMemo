"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  AudioLines,
  Camera,
  Check,
  Circle,
  Headphones,
  Loader2,
  Mic,
  MonitorSpeaker,
  MonitorUp,
  Pause,
  Play,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
} from "lucide-react";

import { Button, buttonClass } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import { Meter } from "@/components/ui/Meter";
import { Pill } from "@/components/ui/Pill";
import { Toggle } from "@/components/ui/Toggle";
import { BRAND } from "@/generated/brand";
import { useAudioLevels, useRecordingStopped } from "@/hooks/use-host-event";
import { DEMO_MODELS, meetingHref } from "@/lib/demo-data";
import { formatClock } from "@/lib/format";
import {
  configureAudioSession,
  createMeeting,
  deactivateAudioSession,
  getAudioCapabilities,
  listCaptureTargets,
  listModels,
  pauseRecording,
  requestMicrophonePermission,
  resumeRecording,
  startRecording,
  stopRecording,
  type CaptureTargetInput,
  type CaptureTargetsResponseRecord,
  type ModelHubResponse,
} from "@/lib/host";
import { openHud } from "@/lib/hud";
import { isImeComposing } from "@/lib/ime";
import { modKeyPrefix } from "@/lib/platform";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

const DIARIZATION_AVAILABLE = true;
const QUICK_TITLES = ["Team Sync", "1:1 Check-in", "Product Review", "Client Call", "Voice Note"];
const CADENCE_OPTIONS = [5, 10, 15, 30, 60] as const;

type SourceId = "system" | "screenshots" | "diarize";

type ProvisionedModelOption = {
  id: string;
  name: string;
  installed: boolean;
  recommended: boolean;
  accelerator: string;
};

function friendlyModelLabel(id: string): string {
  switch (id) {
    case "whisper-large-v3-turbo":
      return "Whisper Large v3 Turbo (Best)";
    case "whisper-small":
      return "Whisper Small (Accurate)";
    case "whisper-tiny":
      return "Whisper Tiny (Fast)";
    case "qwen3.5-4b":
      return "Qwen 3.5 4B (Next-Gen 8GB+)";
    case "gemma-4-e2b-it":
      return "Gemma 4 E2B (Low-RAM 8GB+)";
    case "gemma-4-e4b-it":
      return "Gemma 4 E4B (Pro 16GB+)";
    case "lfm2.5-1.2b-instruct":
      return "LiquidAI LFM 2.5 1.2B (Ultra-Fast)";
    case "lfm2.5-2.6b-instruct":
      return "LiquidAI LFM 2.5 2.6B (Fast)";
    case "qwen2.5-3b-instruct":
      return "Qwen 2.5 3B (Balanced)";
    case "gemma-3-4b-it":
      return "Gemma 3 4B (Deep)";
    default:
      return id;
  }
}

export function NewRecordingDialog() {
  const router = useRouter();
  const open = useWorkspaceStore((state) => state.newRecordingOpen);
  const close = useWorkspaceStore((state) => state.closeNewRecording);
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const preferredSlmId = useWorkspaceStore((state) => state.selectedModelId);
  const setPreferredSlmId = useWorkspaceStore((state) => state.setSelectedModel);
  const chosenAsrId = useWorkspaceStore((state) => state.selectedAsrModelId);
  const setChosenAsrId = useWorkspaceStore((state) => state.setSelectedAsrModel);
  const selectedMic = useWorkspaceStore((state) => state.selectedMicrophone);
  const setSelectedMic = useWorkspaceStore((state) => state.setSelectedMicrophone);

  const [title, setTitle] = useState("");
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [paused, setPaused] = useState(false);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [systemLevel, setSystemLevel] = useState(0);
  const [noSignal, setNoSignal] = useState(false);
  const [capabilities, setCapabilities] = useState<Awaited<
    ReturnType<typeof getAudioCapabilities>
  > | null>(null);
  const [hub, setHub] = useState<ModelHubResponse | null>(null);
  const [targets, setTargets] = useState<CaptureTargetsResponseRecord | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string>("auto");
  const [screenshotCadenceSec, setScreenshotCadenceSec] = useState<number>(
    BRAND.features.defaultScreenshotIntervalSec || 10,
  );
  const [sources, setSources] = useState<Record<SourceId, boolean>>({
    system: true,
    screenshots: BRAND.features.enablePeriodicScreenshots,
    diarize: DIARIZATION_AVAILABLE,
  });
  const attemptRef = useRef(0);
  const peakMicRef = useRef(0);
  const modKey = modKeyPrefix();

  const systemAvailable = capabilities?.systemAudio ?? !isTauri();

  useEffect(() => {
    if (!open || !isTauri()) return;
    let cancelled = false;
    void Promise.all([getAudioCapabilities(), listModels(), listCaptureTargets()]).then(
      ([nextCaps, nextHub, nextTargets]) => {
        if (cancelled) return;
        setCapabilities(nextCaps);
        setHub(nextHub);
        setTargets(nextTargets);
        if (nextCaps?.systemAudio) {
          setSources((curr) => ({ ...curr, system: true }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (capabilities && !capabilities.systemAudio) {
      setSources((current) => (current.system ? { ...current, system: false } : current));
    }
  }, [open, capabilities]);

  const asrOptions = useMemo<ProvisionedModelOption[]>(() => {
    if (isTauri() && hub) {
      return hub.models
        .filter((m) => m.artifact.role === "asr" || m.artifact.role === "fallback_asr")
        .map((m) => ({
          id: m.artifact.id,
          name: friendlyModelLabel(m.artifact.id),
          installed: m.installed,
          recommended: m.artifact.recommended,
          accelerator: m.artifact.accelerator,
        }));
    }
    return DEMO_MODELS.filter((m) => m.role.includes("Speech")).map((m) => ({
      id: m.id,
      name: friendlyModelLabel(m.id),
      installed: m.status === "installed",
      recommended: m.recommended,
      accelerator: m.accelerator,
    }));
  }, [hub]);

  const slmOptions = useMemo<ProvisionedModelOption[]>(() => {
    if (isTauri() && hub) {
      return hub.models
        .filter((m) => m.artifact.role === "slm" || m.artifact.role === "pro_slm")
        .map((m) => ({
          id: m.artifact.id,
          name: friendlyModelLabel(m.artifact.id),
          installed: m.installed,
          recommended: m.artifact.recommended,
          accelerator: m.artifact.accelerator,
        }));
    }
    return DEMO_MODELS.filter((m) => m.role.includes("synthesis")).map((m) => ({
      id: m.id,
      name: friendlyModelLabel(m.id),
      installed: m.status === "installed",
      recommended: m.recommended,
      accelerator: m.accelerator,
    }));
  }, [hub]);

  const selectedAsr = useMemo<ProvisionedModelOption | null>(() => {
    if (chosenAsrId) {
      const match = asrOptions.find((m) => m.id === chosenAsrId);
      if (match) return match;
    }
    return (
      asrOptions.find((m) => m.installed && m.recommended) ??
      asrOptions.find((m) => m.installed) ??
      asrOptions.find((m) => m.recommended) ??
      asrOptions[0] ??
      null
    );
  }, [asrOptions, chosenAsrId]);

  const selectedSlm = useMemo<ProvisionedModelOption | null>(() => {
    if (preferredSlmId) {
      const match = slmOptions.find((m) => m.id === preferredSlmId);
      if (match) return match;
    }
    return (
      slmOptions.find((m) => m.installed && m.recommended) ??
      slmOptions.find((m) => m.installed) ??
      slmOptions.find((m) => m.recommended) ??
      slmOptions[0] ??
      null
    );
  }, [preferredSlmId, slmOptions]);

  useEffect(() => {
    if (!open) {
      setStarted(false);
      setStarting(false);
      setPaused(false);
      setMeetingId(null);
      setElapsedMs(0);
      setMicLevel(0);
      setSystemLevel(0);
      setNoSignal(false);
      peakMicRef.current = 0;
    }
  }, [open]);

  useEffect(() => {
    if (!started || !open || paused) return;
    const timer = window.setInterval(() => setElapsedMs((value) => value + 1_000), 1_000);
    return () => window.clearInterval(timer);
  }, [open, paused, started]);

  useEffect(() => {
    if (!started || !open || paused || isTauri()) return;
    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      setMicLevel(0.34 + Math.abs(Math.sin(frame * 0.72)) * 0.48);
      if (sources.system) {
        setSystemLevel(0.22 + Math.abs(Math.sin(frame * 0.48 + 1.4)) * 0.42);
      }
    }, 140);
    return () => window.clearInterval(timer);
  }, [open, paused, sources.system, started]);

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
        "Allow microphone access in your OS privacy settings, then record again.",
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
    }
  });

  const toggleSource = (source: SourceId) => {
    setSources((current) => ({ ...current, [source]: !current[source] }));
  };

  const handleTogglePause = async () => {
    if (!started) return;
    if (!isTauri() || !meetingId) {
      setPaused((prev) => !prev);
      return;
    }
    try {
      const snap = paused ? await resumeRecording(meetingId) : await pauseRecording(meetingId);
      if (snap) {
        setPaused(Boolean(snap.paused));
      }
    } catch (error) {
      pushToast("Could not toggle pause", formatHostError(error), "danger");
    }
  };

  const start = () => {
    if (starting || started) return;
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setStarted(true);
    setPaused(false);
    setElapsedMs(0);

    if (!isTauri()) return;
    setStarting(true);
    void (async () => {
      try {
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
              "Close other exclusive audio apps or check system audio settings, then try again.",
              "danger",
            );
          }
          return;
        }

        const meeting = await createMeeting({
          title: title.trim() || undefined,
          screenshotIntervalSec: sources.screenshots ? screenshotCadenceSec : 0,
          asrModelId: selectedAsr?.id,
          slmModelId: selectedSlm?.id,
          diarization: sources.diarize,
        });
        if (!meeting) {
          throw new Error("Could not create local meeting record.");
        }
        let captureTarget: CaptureTargetInput = { kind: "auto" };
        if (selectedTargetKey.startsWith("display:")) {
          const id = Number(selectedTargetKey.slice("display:".length));
          if (Number.isFinite(id) && id > 0) captureTarget = { kind: "display", id };
        } else if (selectedTargetKey.startsWith("window:")) {
          const id = Number(selectedTargetKey.slice("window:".length));
          if (Number.isFinite(id) && id > 0) captureTarget = { kind: "window", id };
        }
        const recording = await startRecording(meeting.id, {
          captureSystemAudio: sources.system,
          microphoneDevice: selectedMic || null,
          captureTarget,
        });
        if (attemptRef.current !== attempt) {
          if (recording) await stopRecording(recording.id);
          void deactivateAudioSession();
          return;
        }
        setStarting(false);
        if (!recording) {
          throw new Error("Could not start local audio capture.");
        }
        setMeetingId(recording.id);
      } catch (error) {
        if (attemptRef.current === attempt) {
          setStarting(false);
          setStarted(false);
          void deactivateAudioSession();
          pushToast("Could not start local recording", formatHostError(error), "danger");
        }
      }
    })();
  };

  const openInLiveStudio = () => {
    if (!meetingId) return;
    const targetId = meetingId;
    close();
    router.push(meetingHref(targetId));
  };

  const minimizeToHud = () => {
    void openHud();
    close();
  };

  const stopAndSave = () => {
    attemptRef.current += 1;
    const activeMeeting = meetingId;
    const finalTitle = title.trim() || "Untitled memo";
    const finalElapsed = elapsedMs;
    setMeetingId(null);
    setStarting(false);
    setPaused(false);
    close();
    setTitle("");

    if (activeMeeting) {
      void stopRecording(activeMeeting)
        .then((saved) => {
          pushToast(
            "Recording saved",
            `${formatClock(finalElapsed)} · ${saved?.title ?? finalTitle}`,
            "success",
          );
          router.push(meetingHref(activeMeeting));
        })
        .catch((error) => {
          pushToast("Could not finalize recording", formatHostError(error), "danger");
        })
        .finally(() => {
          void deactivateAudioSession();
        });
    } else {
      void deactivateAudioSession();
      pushToast("Preview take ended", `${formatClock(finalElapsed)} · ${finalTitle}`, "success");
    }
  };

  const handleDismiss = () => {
    if (started && meetingId) {
      openInLiveStudio();
      return;
    }
    attemptRef.current += 1;
    setStarting(false);
    setStarted(false);
    close();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleDismiss();
      }}
      title={started ? "Recording in progress" : "New recording"}
      description={
        started
          ? "Audio is being written directly to your private local vault."
          : "Choose what to capture. You can change transcription and summary models later."
      }
      size="lg"
      footer={
        <>
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <ShieldCheck className="size-3.5 text-accent-primary" aria-hidden="true" />
            <span>Private local vault</span>
            {sources.system && (
              <>
                <span className="opacity-40">·</span>
                <span className="flex items-center gap-1 text-accent-secondary">
                  <Headphones className="size-3" aria-hidden="true" />
                  Dual-channel
                </span>
              </>
            )}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {started ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  leading={
                    paused ? (
                      <Play className="size-3.5 fill-current" />
                    ) : (
                      <Pause className="size-3.5" />
                    )
                  }
                  onClick={() => void handleTogglePause()}
                  disabled={starting}
                >
                  {paused ? "Resume" : "Pause"}
                </Button>
                {isTauri() && meetingId && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      leading={<MonitorUp className="size-3.5" />}
                      onClick={minimizeToHud}
                    >
                      Mini HUD
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      trailing={<ArrowRight className="size-3.5" />}
                      onClick={openInLiveStudio}
                    >
                      Open Studio
                    </Button>
                  </>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  leading={<Square className="size-3 fill-current" />}
                  onClick={stopAndSave}
                  disabled={starting}
                >
                  Stop &amp; Save
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={handleDismiss}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  leading={<Mic className="size-4" />}
                  onClick={start}
                  disabled={starting}
                >
                  {starting ? "Starting…" : "Start Recording"}
                  <Kbd className="ml-1 border-bg-primary/25 bg-bg-primary/15 text-bg-primary">
                    {modKey}N
                  </Kbd>
                </Button>
              </>
            )}
          </div>
        </>
      }
    >
      {started ? (
        <div className="space-y-4">
          {/* Glowing Live Hero Banner */}
          <div className="relative overflow-hidden rounded-2xl border border-recording-pulse/30 bg-[radial-gradient(120%_140%_at_0%_0%,color-mix(in_oklab,var(--brand-recording-pulse)_16%,transparent),var(--glass-surface-subtle))] p-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <span className="relative flex size-11 items-center justify-center rounded-2xl border border-recording-pulse/35 bg-recording-pulse/15">
                  {!paused && (
                    <span className="absolute inset-0 animate-ping rounded-2xl bg-recording-pulse/20" />
                  )}
                  <Circle className="relative size-3.5 fill-recording-pulse text-recording-pulse" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-[15px] font-semibold text-text-primary">
                      {title.trim() || "Untitled Meeting"}
                    </p>
                    <Pill tone={paused ? "warning" : "danger"}>{paused ? "PAUSED" : "LIVE"}</Pill>
                  </div>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-text-muted">
                    {starting ? (
                      <>
                        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                        Initializing audio channels…
                      </>
                    ) : paused ? (
                      "Capture paused · click Resume to continue"
                    ) : (
                      "Streaming to crash-safe 16 kHz WAV archive"
                    )}
                  </p>
                </div>
              </div>
              <div className="tabular text-3xl font-light tracking-[-0.04em] text-text-primary">
                {formatClock(elapsedMs)}
              </div>
            </div>
          </div>

          {/* Live Dual-Channel Meters */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="glass-subtle rounded-2xl p-4">
              <div className="mb-2.5 flex items-center justify-between text-xs font-medium">
                <span className="flex items-center gap-2 text-text-primary">
                  <Mic className="size-4 text-accent-primary" aria-hidden="true" />
                  Your Microphone
                </span>
                <span className="tabular text-text-muted">{Math.round(micLevel * 100)}%</span>
              </div>
              <Meter value={micLevel} label="Microphone input level" />
              <p className="mt-2 truncate text-[11px] text-text-muted">
                {noSignal
                  ? "No signal detected. Check microphone access in your system settings."
                  : selectedMic || "System default microphone"}
              </p>
            </div>

            <div
              className={cn(
                "glass-subtle rounded-2xl p-4",
                !sources.system && "border-dashed opacity-65",
              )}
            >
              <div className="mb-2.5 flex items-center justify-between text-xs font-medium">
                <span className="flex items-center gap-2 text-text-primary">
                  <AudioLines className="size-4 text-accent-secondary" aria-hidden="true" />
                  System Audio (Remote)
                </span>
                <span className="tabular text-text-muted">
                  {sources.system ? `${Math.round(systemLevel * 100)}%` : "Off"}
                </span>
              </div>
              {sources.system ? (
                <>
                  <Meter
                    value={systemLevel}
                    label="System audio level"
                    color="var(--brand-accent-secondary)"
                  />
                  <p className="mt-2 text-[11px] text-text-muted">
                    Capturing meeting audio · wear headphones to avoid echo
                  </p>
                </>
              ) : (
                <p className="text-[11px] leading-5 text-text-muted">
                  System loopback is off for this session. Only your microphone is being recorded.
                </p>
              )}
            </div>
          </div>

          {/* Active Session Summary Strip */}
          <div className="glass-subtle flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill tone="accent" icon={<Check className="size-2.5" />}>
                {selectedAsr?.name.split(" (")[0] ?? "Whisper"}
              </Pill>
              <Pill tone="secondary">{selectedSlm?.name.split(" (")[0] ?? "Local LLM"}</Pill>
              {sources.diarize && <Pill tone="neutral">Speaker ID On</Pill>}
              {sources.screenshots && (
                <Pill tone="neutral">Slides every {screenshotCadenceSec}s</Pill>
              )}
            </div>
            <span className="text-[11px] text-text-muted">5s auto-checkpointing</span>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {/* 1. Hero Meeting Title Input + Quick Presets */}
          <div>
            <label
              htmlFor="recording-title"
              className="mb-1.5 block text-xs font-medium text-text-muted"
            >
              Meeting or memo title
            </label>
            <input
              id="recording-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (isImeComposing(event)) return;
                  start();
                }
              }}
              placeholder="What are we meeting about? (e.g. Q3 Product Review)"
              autoFocus
              className="glass-input h-11 w-full px-3.5 text-[14px] font-medium text-text-primary outline-none transition placeholder:font-normal placeholder:text-text-muted/60 focus:border-accent-primary/60"
            />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] text-text-muted/75">Quick title:</span>
              {QUICK_TITLES.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setTitle(preset)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition",
                    title === preset
                      ? "border-accent-primary/40 bg-accent-primary/14 font-medium text-accent-primary"
                      : "border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] text-text-muted hover:border-text-muted/35 hover:text-text-primary",
                  )}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Audio Channels Showcase (2 Interactive Glass Cards) */}
          <div>
            <p className="mb-2 text-xs font-medium text-text-muted">What should I record?</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {/* Microphone Card */}
              <div className="glass-subtle flex flex-col justify-between rounded-2xl border-accent-primary/30 bg-[color-mix(in_oklab,var(--brand-accent-primary)_5%,var(--glass-surface-subtle))] p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-accent-primary/30 bg-accent-primary/14 text-accent-primary">
                      <Mic className="size-4" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold text-text-primary">My microphone</p>
                      <p className="text-[11px] text-text-muted">Records your voice</p>
                    </div>
                  </div>
                  <Pill tone="accent" icon={<Check className="size-2.5" />}>
                    On
                  </Pill>
                </div>

                <div className="mt-3">
                  <select
                    id="recording-mic-select"
                    aria-label="Microphone input device"
                    value={selectedMic}
                    onChange={(e) => setSelectedMic(e.target.value)}
                    className="glass-input h-8 w-full px-2.5 text-xs text-text-primary outline-none focus:border-accent-primary/50"
                  >
                    <option value="">System default microphone</option>
                    {targets?.microphones.map((mic) => (
                      <option key={mic} value={mic}>
                        {mic}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* System Audio Loopback Card */}
              <div
                onClick={() => {
                  if (systemAvailable) toggleSource("system");
                }}
                className={cn(
                  "glass-subtle flex cursor-pointer flex-col justify-between rounded-2xl p-3.5 transition",
                  sources.system && systemAvailable
                    ? "border-accent-secondary/35 bg-[color-mix(in_oklab,var(--brand-accent-secondary)_6%,var(--glass-surface-subtle))]"
                    : "opacity-80 hover:opacity-100",
                  !systemAvailable && "cursor-not-allowed opacity-55",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-xl border",
                        sources.system && systemAvailable
                          ? "border-accent-secondary/35 bg-accent-secondary/14 text-accent-secondary"
                          : "border-[var(--glass-border-strong)] bg-[var(--glass-surface)] text-text-muted",
                      )}
                    >
                      <MonitorSpeaker className="size-4" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold text-text-primary">
                        Other people in the call
                      </p>
                      <p className="text-[11px] text-text-muted">
                        Zoom, Meet, Teams, and other apps
                      </p>
                    </div>
                  </div>
                  {systemAvailable ? (
                    <Toggle
                      checked={sources.system}
                      onChange={() => toggleSource("system")}
                      label="Toggle system audio loopback"
                      size="sm"
                    />
                  ) : (
                    <Pill tone="outline">Unavailable</Pill>
                  )}
                </div>

                <p className="mt-3 text-[11px] leading-4 text-text-muted">
                  {sources.system && systemAvailable
                    ? "Recommended for online meetings. Keeps voices on a separate track."
                    : "Turn this on for online meetings."}
                </p>
              </div>
            </div>
          </div>

          <details className="group overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface-subtle)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 marker:hidden">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface)] text-text-muted">
                  <Settings2 className="size-4" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-[13px] font-semibold text-text-primary">Advanced settings</p>
                  <p className="text-[11.5px] text-text-muted">
                    Speaker labels, slide capture, and local AI models
                  </p>
                </div>
              </div>
              <span className="text-[11px] font-medium text-accent-primary group-open:hidden">
                Show
              </span>
              <span className="hidden text-[11px] font-medium text-accent-primary group-open:inline">
                Hide
              </span>
            </summary>

            <div className="space-y-2.5 border-t border-[var(--glass-border)] p-3.5">
              {/* Speaker Diarization Row */}
              <div
                onClick={() => toggleSource("diarize")}
                className="glass-subtle flex cursor-pointer items-center justify-between gap-3 rounded-2xl px-4 py-3 transition hover:border-[var(--glass-border-strong)]"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-xl border",
                      sources.diarize
                        ? "border-accent-primary/30 bg-accent-primary/12 text-accent-primary"
                        : "border-[var(--glass-border)] bg-[var(--glass-surface)] text-text-muted",
                    )}
                  >
                    <Users className="size-4" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-[13px] font-medium text-text-primary">
                      Automatic Speaker Labels
                    </p>
                    <p className="text-[11.5px] text-text-muted">
                      Separates voices and matches enrolled speakers on-device
                    </p>
                  </div>
                </div>
                <Toggle
                  checked={sources.diarize}
                  onChange={() => toggleSource("diarize")}
                  label="Toggle speaker diarization"
                  size="sm"
                />
              </div>

              {/* Visual Slide Capture Card with Inline Cadence + Target Controls */}
              {BRAND.features.enablePeriodicScreenshots && (
                <div className="glass-subtle rounded-2xl p-3.5 transition">
                  <div
                    onClick={() => toggleSource("screenshots")}
                    className="flex cursor-pointer items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-xl border",
                          sources.screenshots
                            ? "border-accent-secondary/35 bg-accent-secondary/14 text-accent-secondary"
                            : "border-[var(--glass-border)] bg-[var(--glass-surface)] text-text-muted",
                        )}
                      >
                        <Camera className="size-4" aria-hidden="true" />
                      </span>
                      <div>
                        <p className="text-[13px] font-medium text-text-primary">
                          Smart Slide &amp; Screen Capture
                        </p>
                        <p className="text-[11.5px] text-text-muted">
                          Automatically captures shared slides and processes text on-device
                        </p>
                      </div>
                    </div>
                    <Toggle
                      checked={sources.screenshots}
                      onChange={() => toggleSource("screenshots")}
                      label="Toggle periodic screenshots"
                      size="sm"
                    />
                  </div>

                  {sources.screenshots && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--glass-border)] pt-3">
                      <div className="flex items-center gap-1.5">
                        <span className="mr-1 text-[11px] font-medium text-text-muted">
                          Interval:
                        </span>
                        {CADENCE_OPTIONS.map((sec) => (
                          <button
                            key={sec}
                            type="button"
                            onClick={() => setScreenshotCadenceSec(sec)}
                            className={cn(
                              "tabular rounded-lg border px-2 py-0.5 text-[11px] font-medium transition",
                              screenshotCadenceSec === sec
                                ? "border-accent-secondary/45 bg-accent-secondary/15 text-accent-secondary"
                                : "border-[var(--glass-border)] bg-[var(--glass-surface)] text-text-muted hover:text-text-primary",
                            )}
                          >
                            {sec}s
                          </button>
                        ))}
                      </div>

                      {isTauri() && targets && targets.visualTargets.length > 0 && (
                        <select
                          id="recording-target-select"
                          aria-label="Slide capture source"
                          value={selectedTargetKey}
                          onChange={(e) => setSelectedTargetKey(e.target.value)}
                          className="glass-input h-7 max-w-[240px] px-2.5 text-[11.5px] text-text-primary outline-none focus:border-accent-primary/50"
                        >
                          <option value="auto">Main screen (excludes HUD)</option>
                          {targets.visualTargets.map((t) => (
                            <option key={`${t.kind}:${t.id}`} value={`${t.kind}:${t.id}`}>
                              {t.kind === "window" ? `Window: ${t.title}` : t.title}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Compact AI Models Selection Bar */}
              <div className="glass-subtle grid gap-3 rounded-2xl p-3.5 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="recording-asr-select"
                    className="mb-1 flex items-center justify-between text-[11px] font-medium text-text-muted"
                  >
                    <span className="flex items-center gap-1.5">
                      <AudioLines className="size-3 text-accent-primary" aria-hidden="true" />
                      Voice Recognition
                    </span>
                    <span
                      className={cn(
                        "text-[10.5px]",
                        selectedAsr?.installed ? "text-accent-primary" : "text-amber-400",
                      )}
                    >
                      {selectedAsr?.installed ? "Ready" : "Not installed"}
                    </span>
                  </label>
                  <select
                    id="recording-asr-select"
                    value={selectedAsr?.id ?? ""}
                    onChange={(e) => setChosenAsrId(e.target.value)}
                    className="glass-input h-8 w-full px-2.5 text-xs text-text-primary outline-none focus:border-accent-primary/50"
                  >
                    {asrOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} {m.installed ? "✓" : "(Download in AI Models)"}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="recording-slm-select"
                    className="mb-1 flex items-center justify-between text-[11px] font-medium text-text-muted"
                  >
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="size-3 text-accent-secondary" aria-hidden="true" />
                      AI Summary Model
                    </span>
                    <span
                      className={cn(
                        "text-[10.5px]",
                        selectedSlm?.installed ? "text-accent-primary" : "text-amber-400",
                      )}
                    >
                      {selectedSlm?.installed ? "Ready" : "Not installed"}
                    </span>
                  </label>
                  <select
                    id="recording-slm-select"
                    value={selectedSlm?.id ?? ""}
                    onChange={(e) => setPreferredSlmId(e.target.value)}
                    className="glass-input h-8 w-full px-2.5 text-xs text-text-primary outline-none focus:border-accent-primary/50"
                  >
                    {slmOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} {m.installed ? "✓" : "(Download in AI Models)"}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {isTauri() && selectedAsr && !selectedAsr.installed && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3.5 py-2.5 text-xs text-text-primary">
                  <span>
                    Audio will be recorded now. Install a Voice Recognition model anytime to
                    transcribe it.
                  </span>
                  <Link
                    href="/models/"
                    onClick={close}
                    className={buttonClass({ variant: "secondary", size: "xs" })}
                  >
                    Open AI Models
                  </Link>
                </div>
              )}
            </div>
          </details>
        </div>
      )}
    </Dialog>
  );
}
