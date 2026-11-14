"use client";

import { useEffect, useState } from "react";
import {
  AudioLines,
  ChevronDown,
  Circle,
  Cpu,
  Mic,
  MicOff,
  MonitorSpeaker,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Volume2,
  VolumeX,
} from "lucide-react";

import { IconButton } from "@/components/ui/IconButton";
import { Meter } from "@/components/ui/Meter";
import { Pill } from "@/components/ui/Pill";
import { Popover } from "@/components/ui/Popover";
import type { Meeting } from "@/lib/demo-data";
import { getSpeaker } from "@/lib/demo-data";
import { formatTimestamp, percent } from "@/lib/format";
import { cn } from "@/lib/utils";

const MIC_DEVICES = ["MacBook Pro Microphone", "AirPods Pro", "USB Audio Interface"];
const SYSTEM_DEVICES = ["System loopback · ScreenCaptureKit", "BlackHole 2ch", "Aggregate Device"];

function ChannelCard({
  channel,
  level,
  muted,
  gain,
  device,
  devices,
  active,
  onMute,
  onGain,
  onDevice,
}: {
  channel: "mic" | "system";
  level: number;
  muted: boolean;
  gain: number;
  device: string;
  devices: string[];
  active: boolean;
  onMute: () => void;
  onGain: (value: number) => void;
  onDevice: (value: string) => void;
}) {
  const isMic = channel === "mic";
  const Icon = isMic ? Mic : AudioLines;
  const MuteIcon = muted ? (isMic ? MicOff : VolumeX) : Volume2;
  const color = isMic ? "var(--brand-accent-primary)" : "var(--brand-accent-secondary)";

  return (
    <div
      className={cn(
        "rounded-[7px] border bg-bg-primary/30 p-2.5 transition-colors",
        active ? "border-accent-primary/35 bg-accent-primary/[0.04]" : "border-border-subtle",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3", active ? "text-accent-primary" : "text-text-muted")} />
        <span className="text-[10px] font-medium text-text-primary">
          {isMic ? "Mic · You" : "System · Remote"}
        </span>
        {active && (
          <span className="ml-0.5 flex items-center gap-0.5" aria-label="Active channel">
            {[3, 5, 2].map((height, index) => (
              <span
                key={index}
                className="w-[2px] animate-pulse rounded-full bg-accent-primary"
                style={{ height, animationDelay: `${index * 120}ms` }}
              />
            ))}
          </span>
        )}
        <button
          type="button"
          onClick={onMute}
          aria-label={`${muted ? "Unmute" : "Mute"} ${isMic ? "microphone" : "system audio"}`}
          aria-pressed={muted}
          className={cn(
            "ml-auto flex size-5 items-center justify-center rounded-[4px] transition",
            muted
              ? "bg-recording-pulse/10 text-recording-pulse"
              : "text-text-muted hover:bg-bg-elevated hover:text-text-primary",
          )}
        >
          <MuteIcon className="size-3" />
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <Meter
          value={level * gain}
          label={`${isMic ? "Microphone" : "System audio"} level`}
          color={color}
          muted={muted}
          segments={20}
          className="h-2.5 flex-1"
        />
        <span className="tabular w-7 text-right text-[8px] text-text-muted">
          {muted ? "—" : percent(level * gain)}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <select
            value={device}
            onChange={(event) => onDevice(event.target.value)}
            aria-label={`${isMic ? "Microphone" : "System audio"} device`}
            className="h-5 w-full appearance-none truncate rounded-[4px] border border-border-subtle bg-bg-primary/45 pl-1.5 pr-5 text-[8.5px] text-text-muted outline-none transition hover:border-text-muted/30 focus:border-accent-primary/50"
          >
            {devices.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-2.5 -translate-y-1/2 text-text-muted/60" />
        </div>
        <div className="flex shrink-0 items-center gap-1" title={`Gain ${Math.round(gain * 100)}%`}>
          <Volume2 className="size-2.5 text-text-muted/60" />
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(gain * 100)}
            onChange={(event) => onGain(Number(event.target.value) / 100)}
            aria-label={`${isMic ? "Microphone" : "System audio"} gain`}
            className="h-1 w-8 cursor-pointer accent-[var(--brand-accent-primary)]"
          />
        </div>
      </div>
    </div>
  );
}

export function AudioMeterHeader({
  meeting,
  activeSpeakerId,
  currentMs,
}: {
  meeting: Meeting;
  activeSpeakerId: string | null;
  currentMs: number;
}) {
  const [micLevel, setMicLevel] = useState(0.46);
  const [sysLevel, setSysLevel] = useState(0.27);
  const [micMuted, setMicMuted] = useState(false);
  const [sysMuted, setSysMuted] = useState(false);
  const [micGain, setMicGain] = useState(0.82);
  const [sysGain, setSysGain] = useState(0.74);
  const [micDevice, setMicDevice] = useState(MIC_DEVICES[0]);
  const [systemDevice, setSystemDevice] = useState(SYSTEM_DEVICES[0]);

  useEffect(() => {
    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      setMicLevel(0.28 + Math.abs(Math.sin(frame * 0.61)) * 0.58);
      setSysLevel(0.14 + Math.abs(Math.sin(frame * 0.43 + 2.1)) * 0.52);
    }, 160);
    return () => window.clearInterval(timer);
  }, []);

  const activeSpeaker = activeSpeakerId ? getSpeaker(meeting, activeSpeakerId) : null;

  return (
    <section
      aria-label="Live audio and transcription status"
      className="shrink-0 border-b border-border-subtle bg-bg-primary"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border-subtle px-3.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-recording-pulse opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-recording-pulse" />
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-primary">
            Live transcript
          </span>
          <Pill tone="danger" className="px-1.5">
            REC
          </Pill>
        </div>
        <span className="tabular text-[9px] text-text-muted">
          {formatTimestamp(currentMs)} / {formatTimestamp(meeting.durationMs)}
        </span>
        <span className="hidden items-center gap-1 text-[9px] text-text-muted sm:flex">
          <span className="text-border-subtle">·</span>
          {activeSpeaker ? `${activeSpeaker.name} speaking` : "listening…"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden items-center gap-1 text-[8.5px] text-text-muted lg:flex">
            <Circle className="size-2 fill-accent-primary text-accent-primary" />
            LiteRT · 640 ms
          </span>
          <Popover
            label="Capture pipeline"
            align="end"
            panelClassName="w-64"
            trigger={(props) => (
              <button
                {...props}
                aria-label="Capture pipeline details"
                className="flex size-6 items-center justify-center rounded-[4px] text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
              >
                <Settings2 className="size-3" />
              </button>
            )}
          >
            {() => (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold text-text-primary">Capture pipeline</p>
                <dl className="space-y-1.5 text-[9px]">
                  {[
                    ["ASR", "whisper-small · on-device"],
                    ["Source", "microphone"],
                    ["Archive", "16 kHz mono WAV"],
                    ["Sample rate", "48 kHz internal mix"],
                    ["Verifier", "local · fail closed"],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-2">
                      <dt className="text-text-muted">{label}</dt>
                      <dd className="text-right font-mono text-[8px] text-text-primary/85">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="flex items-center gap-1 border-t border-border-subtle pt-2 text-[8.5px] text-accent-primary">
                  <ShieldCheck className="size-2.5" /> no network egress
                </div>
              </div>
            )}
          </Popover>
          <IconButton label="Audio controls" size="sm">
            <SlidersHorizontal className="size-3" />
          </IconButton>
        </div>
      </div>

      <div className="grid gap-2 px-3.5 py-2 sm:grid-cols-2">
        <ChannelCard
          channel="mic"
          level={micLevel}
          muted={micMuted}
          gain={micGain}
          device={micDevice}
          devices={MIC_DEVICES}
          active={activeSpeakerId === "you"}
          onMute={() => setMicMuted((value) => !value)}
          onGain={setMicGain}
          onDevice={setMicDevice}
        />
        <ChannelCard
          channel="system"
          level={sysLevel}
          muted={sysMuted}
          gain={sysGain}
          device={systemDevice}
          devices={SYSTEM_DEVICES}
          active={Boolean(activeSpeakerId && activeSpeakerId !== "you")}
          onMute={() => setSysMuted((value) => !value)}
          onGain={setSysGain}
          onDevice={setSystemDevice}
        />
      </div>
    </section>
  );
}
