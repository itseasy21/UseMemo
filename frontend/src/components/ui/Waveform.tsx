"use client";

import { useMemo, type KeyboardEvent, type MouseEvent } from "react";

import { speakerBarColor } from "@/lib/display";
import type { SpeakerTone } from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

export type WaveBand = {
  startMs: number;
  endMs: number;
  tone: SpeakerTone;
};

export type WaveMarker = {
  id: string;
  startMs: number;
  kind: "note" | "decision" | "screenshot" | "bookmark";
  label: string;
  tone?: SpeakerTone;
};

function barSeed(index: number): number {
  const wave =
    Math.sin(index * 0.47) * 0.52 +
    Math.sin(index * 0.17 + 1.3) * 0.28 +
    Math.sin(index * 1.13 + 0.7) * 0.2;
  return Math.max(0.08, Math.min(1, Math.abs(wave) * 0.82 + 0.14));
}

function bandAt(bands: WaveBand[], timeMs: number): WaveBand | undefined {
  return bands.find((band) => timeMs >= band.startMs && timeMs < band.endMs);
}

export function Waveform({
  durationMs,
  currentMs,
  bands,
  markers = [],
  onSeek,
  height = 40,
  bars = 160,
  className,
  dense = false,
}: {
  durationMs: number;
  currentMs: number;
  bands: WaveBand[];
  markers?: WaveMarker[];
  onSeek?: (ms: number) => void;
  height?: number;
  bars?: number;
  className?: string;
  dense?: boolean;
}) {
  const duration = Math.max(1, durationMs);
  const currentRatio = Math.max(0, Math.min(1, currentMs / duration));

  const samples = useMemo(
    () =>
      Array.from({ length: bars }).map((_, index) => {
        const ratio = (index + 0.5) / bars;
        const timeMs = ratio * duration;
        const band = bandAt(bands, timeMs);
        return {
          ratio,
          height: barSeed(index) * 100,
          color: speakerBarColor(band?.tone ?? "accent"),
        };
      }),
    [bands, bars, duration],
  );

  const seekFromEvent = (event: MouseEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onSeek(Math.min(duration, currentMs + (event.shiftKey ? 15_000 : 2_000)));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      onSeek(Math.max(0, currentMs - (event.shiftKey ? 15_000 : 2_000)));
    } else if (event.key === "Home") {
      event.preventDefault();
      onSeek(0);
    } else if (event.key === "End") {
      event.preventDefault();
      onSeek(duration);
    }
  };

  return (
    <div
      className={cn(
        "group relative w-full select-none rounded-[3px] bg-bg-primary/35",
        onSeek && "cursor-crosshair",
        className,
      )}
      style={{ height }}
      role="slider"
      aria-label="Meeting timeline"
      aria-valuemin={0}
      aria-valuemax={durationMs}
      aria-valuenow={Math.round(currentMs)}
      aria-valuetext={`${formatTimestamp(currentMs)} of ${formatTimestamp(durationMs)}`}
      tabIndex={onSeek ? 0 : -1}
      onClick={seekFromEvent}
      onKeyDown={handleKeyDown}
    >
      <div className="absolute inset-x-0 top-0 flex h-[3px] overflow-hidden rounded-t-[3px]">
        {bands.map((band, index) => (
          <span
            key={`${band.startMs}-${index}`}
            className="h-full opacity-70"
            style={{
              width: `${((band.endMs - band.startMs) / duration) * 100}%`,
              backgroundColor: speakerBarColor(band.tone),
            }}
          />
        ))}
      </div>

      <div className="absolute inset-x-0 bottom-0 top-[3px] flex items-center gap-[1.5px] px-0.5">
        {samples.map((sample, index) => {
          const nearPlayhead = Math.abs(sample.ratio - currentRatio) < 0.7 / bars;
          const distance = Math.abs(sample.ratio - currentRatio);
          return (
            <span
              key={index}
              className="min-w-px flex-1 rounded-full transition-[opacity] duration-150"
              style={{
                height: `${Math.max(6, sample.height)}%`,
                backgroundColor: nearPlayhead ? "var(--brand-text-primary)" : sample.color,
                opacity: nearPlayhead ? 1 : 0.28 + (1 - distance) * 0.5,
              }}
            />
          );
        })}
      </div>

      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          title={marker.label}
          aria-label={marker.label}
          onClick={(event) => {
            event.stopPropagation();
            onSeek?.(marker.startMs);
          }}
          className={cn(
            "absolute bottom-0 z-10 size-2 -translate-x-1/2 translate-y-1/2 rotate-45 rounded-[1px] border transition-transform hover:scale-150",
            marker.kind === "screenshot"
              ? "border-accent-secondary bg-accent-secondary"
              : marker.kind === "decision"
                ? "border-accent-primary bg-accent-primary"
                : "border-border-subtle bg-text-muted",
            dense && "size-1.5",
          )}
          style={{ left: `${(marker.startMs / duration) * 100}%` }}
        />
      ))}

      <div
        className="pointer-events-none absolute inset-y-0 z-20 w-px bg-text-primary/80"
        style={{ left: `${currentRatio * 100}%` }}
      >
        <span className="absolute -left-[3px] top-0 size-[7px] rounded-full border border-bg-primary bg-text-primary shadow-sm" />
      </div>
    </div>
  );
}

export function MiniWaveform({
  seed = 7,
  bars = 34,
  playing = false,
  className,
  tone = "accent",
}: {
  seed?: number;
  bars?: number;
  playing?: boolean;
  className?: string;
  tone?: "accent" | "secondary" | "muted";
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex h-6 items-center gap-[2px]", className)}
      style={{ color: tone === "muted" ? "var(--brand-text-muted)" : undefined }}
    >
      {Array.from({ length: bars }).map((_, index) => (
        <span
          key={index}
          className={cn(
            "w-px shrink-0 rounded-full",
            tone === "accent" && "bg-accent-primary/70",
            tone === "secondary" && "bg-accent-secondary/70",
            tone === "muted" && "bg-text-muted/40",
            playing && "animate-pulse",
          )}
          style={{
            height: `${Math.max(16, barSeed(index + seed * 13) * 100)}%`,
            animationDelay: `${(index % 8) * 80}ms`,
          }}
        />
      ))}
    </div>
  );
}
