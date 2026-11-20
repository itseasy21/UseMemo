"use client";

import { useEffect, useState } from "react";
import {
  AudioLines,
  Circle,
  Mic,
  MicOff,
  Pause,
  Play,
  SlidersHorizontal,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Meter } from "@/components/ui/Meter";
import { Pill } from "@/components/ui/Pill";
import { Popover } from "@/components/ui/Popover";
import { useAudioLevels, useMeetingChanged, useRecordingStopped } from "@/hooks/use-host-event";
import type { Meeting } from "@/lib/demo-data";
import { formatClock, formatTimestamp } from "@/lib/format";
import {
  deactivateAudioSession,
  getAudioCapabilities,
  pauseRecording,
  recordingStatus,
  resumeRecording,
  stopRecording,
  type AudioCapabilitiesRecord,
  type RecordingSnapshot,
} from "@/lib/host";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { useWorkspaceStore } from "@/stores/workspace";

function CompactChannelPill({
  channel,
  level,
  muted,
  disabled,
  onMute,
}: {
  channel: "mic" | "system";
  level: number;
  muted: boolean;
  disabled?: boolean;
  onMute: () => void;
}) {
  const isMic = channel === "mic";
  const Icon = isMic ? Mic : AudioLines;
  const MuteIcon = muted ? (isMic ? MicOff : VolumeX) : Icon;
  const color = isMic ? "var(--brand-accent-primary)" : "var(--brand-accent-secondary)";

  return (
    <div
      className={cn(
        "glass-subtle inline-flex h-8 items-center gap-2 rounded-xl px-2.5 transition",
        disabled && "opacity-50",
      )}
    >
      <button
        type="button"
        onClick={onMute}
        disabled={disabled}
        aria-label={`${muted ? "Unmute" : "Mute"} ${isMic ? "microphone" : "system audio"}`}
        aria-pressed={muted}
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium transition disabled:cursor-not-allowed",
          muted ? "text-recording-pulse" : "text-text-primary hover:text-accent-primary",
        )}
      >
        <MuteIcon
          className={cn(
            "size-3.5",
            muted
              ? "text-recording-pulse"
              : isMic
                ? "text-accent-primary"
                : "text-accent-secondary",
          )}
          aria-hidden="true"
        />
        <span className="hidden sm:inline">{isMic ? "Mic" : "System"}</span>
      </button>
      <Meter
        value={disabled ? 0 : level}
        label={`${isMic ? "Microphone" : "System audio"} level`}
        color={color}
        muted={muted || Boolean(disabled)}
        segments={10}
        className="h-2 w-14"
      />
    </div>
  );
}

export function AudioMeterHeader({
  meeting,
  activeSpeakerId,
  currentMs,
  onReload,
}: {
  meeting: Meeting;
  activeSpeakerId: string | null;
  currentMs: number;
  onReload?: () => Promise<void>;
}) {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const micMuted = usePlayerStore((state) => state.micMuted);
  const sysMuted = usePlayerStore((state) => state.sysMuted);
  const micGain = usePlayerStore((state) => state.micGain);
  const sysGain = usePlayerStore((state) => state.sysGain);
  const setMicMuted = usePlayerStore((state) => state.setMicMuted);
  const setSysMuted = usePlayerStore((state) => state.setSysMuted);
  const setMicGain = usePlayerStore((state) => state.setMicGain);
  const setSysGain = usePlayerStore((state) => state.setSysGain);

  const [snapshot, setSnapshot] = useState<RecordingSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<AudioCapabilitiesRecord | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [sysLevel, setSysLevel] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const native = isTauri();
  const isRecordingThisMeeting =
    meeting.status === "recording" || snapshot?.meetingId === meeting.id;

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    void Promise.all([recordingStatus(), getAudioCapabilities()]).then(([rec, caps]) => {
      if (cancelled) return;
      setSnapshot(rec);
      setCapabilities(caps);
    });
    return () => {
      cancelled = true;
    };
  }, [meeting.id, meeting.status, native]);

  useMeetingChanged((payload) => {
    if (payload.meeting.id !== meeting.id) return;
    void recordingStatus().then((rec) => setSnapshot(rec));
  }, native);

  useRecordingStopped((payload) => {
    if (payload.meetingId !== meeting.id) return;
    setSnapshot(null);
    setMicLevel(0);
    setSysLevel(0);
  }, native);

  useEffect(() => {
    if (!isRecordingThisMeeting) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isRecordingThisMeeting]);

  useAudioLevels((payload) => {
    if (payload.meetingId !== meeting.id) return;
    if (payload.deviceError) {
      pushToast("Audio device warning", payload.deviceError, "danger");
    }
    const level = Math.max(0, Math.min(1, (payload.rmsDbfs + 60) / 60));
    if (payload.channel === "system") {
      setSysLevel(level);
    } else {
      setMicLevel(level);
    }
  }, native && isRecordingThisMeeting);

  useEffect(() => {
    if (native && !isPlaying) {
      if (!isRecordingThisMeeting) {
        setMicLevel(0);
        setSysLevel(0);
      }
      return;
    }
    if (native && isRecordingThisMeeting) return;
    if (!native && !isPlaying && !meeting.isDemo) return;

    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      const micActive = !native || activeSpeakerId === "you" || Boolean(meeting.audioFilePath);
      const sysActive =
        !native ||
        Boolean(activeSpeakerId && activeSpeakerId !== "you") ||
        Boolean(meeting.systemAudioFilePath);
      setMicLevel(micActive ? 0.22 + Math.abs(Math.sin(frame * 0.61)) * 0.52 : 0.04);
      setSysLevel(sysActive ? 0.14 + Math.abs(Math.sin(frame * 0.43 + 2.1)) * 0.48 : 0.02);
    }, 160);
    return () => window.clearInterval(timer);
  }, [
    activeSpeakerId,
    isPlaying,
    isRecordingThisMeeting,
    meeting.audioFilePath,
    meeting.isDemo,
    meeting.systemAudioFilePath,
    native,
  ]);

  const handleTogglePause = async () => {
    if (!native || !isRecordingThisMeeting) return;
    try {
      const next = snapshot?.paused
        ? await resumeRecording(meeting.id)
        : await pauseRecording(meeting.id);
      if (next) setSnapshot(next);
      pushToast(
        next?.paused ? "Recording paused" : "Recording resumed",
        next?.paused ? "Audio & periodic screenshots are paused." : "Audio capture resumed.",
        "default",
      );
    } catch (error) {
      pushToast("Could not toggle pause", formatHostError(error), "danger");
    }
  };

  const handleStopRecording = async () => {
    if (stopping || !isRecordingThisMeeting) return;
    setStopping(true);
    try {
      await stopRecording(meeting.id);
      await deactivateAudioSession();
      await onReload?.();
      pushToast("Recording saved", `${meeting.title} finalized locally.`, "success");
    } catch (error) {
      pushToast("Could not stop recording", formatHostError(error), "danger");
    } finally {
      setStopping(false);
    }
  };

  const liveElapsedMs =
    isRecordingThisMeeting && snapshot?.startedAtMs
      ? Math.max(0, nowMs - snapshot.startedAtMs)
      : currentMs;

  const micDeviceLabel = native
    ? snapshot?.micDevice ||
      (meeting.audioFilePath ? "Saved 16 kHz mono WAV" : "Default microphone")
    : "Local microphone (preview)";

  const hasSystemChannel =
    !native ||
    Boolean(meeting.systemAudioFilePath) ||
    (isRecordingThisMeeting && Boolean(capabilities?.systemAudio));

  const systemDeviceLabel = native
    ? meeting.systemAudioFilePath
      ? `Loopback WAV · ${capabilities?.systemBackend ?? "system"}`
      : capabilities?.systemBackend === "screencapturekit"
        ? "ScreenCaptureKit loopback"
        : capabilities?.systemBackend === "wasapi"
          ? "WASAPI loopback"
          : "Loopback off"
    : "System loopback (preview)";

  return (
    <section
      aria-label="Audio channels and capture status"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] px-3.5 py-2.5"
    >
      {/* Left: Live Recording or Saved Status */}
      <div className="flex items-center gap-2">
        {isRecordingThisMeeting ? (
          <div className="flex items-center gap-2 rounded-full border border-recording-pulse/30 bg-recording-pulse/12 px-2.5 py-1">
            <span className="relative flex size-2">
              {!snapshot?.paused && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-recording-pulse opacity-65" />
              )}
              <span className="relative inline-flex size-2 rounded-full bg-recording-pulse" />
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-recording-pulse">
              {snapshot?.paused ? "Paused" : "Live"}
            </span>
            <span className="tabular text-xs font-medium text-text-primary">
              {formatClock(liveElapsedMs)}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Circle
              aria-hidden="true"
              className={cn(
                "size-2",
                isPlaying
                  ? "fill-accent-primary text-accent-primary"
                  : "fill-text-muted/40 text-text-muted/40",
              )}
            />
            <span className="tabular text-xs font-medium text-text-primary">
              {formatTimestamp(currentMs)}
              <span className="text-text-muted"> / {formatTimestamp(meeting.durationMs)}</span>
            </span>
            <Pill tone={meeting.audioFilePath || meeting.isDemo ? "accent" : "outline"}>
              {meeting.isDemo ? "Demo" : meeting.audioFilePath ? "Audio Ready" : "Notes Only"}
            </Pill>
          </div>
        )}
      </div>

      {/* Center/Right: Compact Channel Meters + Recording Controls */}
      <div className="flex flex-wrap items-center gap-1.5">
        <CompactChannelPill
          channel="mic"
          level={micLevel * micGain}
          muted={micMuted}
          disabled={native && !isRecordingThisMeeting && !meeting.audioFilePath}
          onMute={() => setMicMuted(!micMuted)}
        />
        <CompactChannelPill
          channel="system"
          level={sysLevel * sysGain}
          muted={sysMuted}
          disabled={!hasSystemChannel}
          onMute={() => setSysMuted(!sysMuted)}
        />

        {isRecordingThisMeeting && (
          <>
            <Button
              variant="secondary"
              size="xs"
              leading={
                snapshot?.paused ? (
                  <Play className="size-3 fill-current" />
                ) : (
                  <Pause className="size-3" />
                )
              }
              disabled={stopping}
              onClick={() => void handleTogglePause()}
            >
              {snapshot?.paused ? "Resume" : "Pause"}
            </Button>
            <Button
              variant="danger"
              size="xs"
              leading={<Square className="size-3 fill-current" />}
              disabled={stopping}
              onClick={() => void handleStopRecording()}
            >
              {stopping ? "Saving…" : "Stop"}
            </Button>
          </>
        )}

        {/* Audio Mixer & Channel Details Popover */}
        <Popover
          label="Audio mixer and channel details"
          align="end"
          panelClassName="w-72"
          trigger={(props) => (
            <button
              {...props}
              aria-label="Audio mixer and channel settings"
              title="Audio mixer & channels"
              className="glass-subtle flex size-8 items-center justify-center rounded-xl text-text-muted transition hover:text-text-primary"
            >
              <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            </button>
          )}
        >
          {() => (
            <div className="space-y-3 p-1">
              <p className="text-xs font-semibold text-text-primary">Audio Channels &amp; Gain</p>

              <div className="space-y-2.5 text-xs">
                <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-text-primary">Microphone (You)</span>
                    <span className="tabular text-[11px] text-text-muted">
                      {Math.round(micGain * 100)}%
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[10.5px] text-text-muted">{micDeviceLabel}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <Volume2 className="size-3.5 text-text-muted" aria-hidden="true" />
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(micGain * 100)}
                      onChange={(e) => setMicGain(Number(e.target.value) / 100)}
                      aria-label="Microphone playback gain"
                      className="h-1.5 flex-1 cursor-pointer accent-[var(--brand-accent-primary)]"
                    />
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-text-primary">System Audio (Remote)</span>
                    <span className="tabular text-[11px] text-text-muted">
                      {hasSystemChannel ? `${Math.round(sysGain * 100)}%` : "Off"}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[10.5px] text-text-muted">
                    {systemDeviceLabel}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Volume2 className="size-3.5 text-text-muted" aria-hidden="true" />
                    <input
                      type="range"
                      min={0}
                      max={100}
                      disabled={!hasSystemChannel}
                      value={Math.round(sysGain * 100)}
                      onChange={(e) => setSysGain(Number(e.target.value) / 100)}
                      aria-label="System audio playback gain"
                      className="h-1.5 flex-1 cursor-pointer accent-[var(--brand-accent-secondary)] disabled:opacity-40"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </Popover>
      </div>
    </section>
  );
}
