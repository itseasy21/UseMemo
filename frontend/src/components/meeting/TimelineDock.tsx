"use client";

import { Play, Pause, Camera, Captions, Flag, Layers, ShieldCheck } from "lucide-react";

import { SlideThumbnail } from "@/components/ui/SlideThumbnail";
import { Waveform, type WaveBand, type WaveMarker } from "@/components/ui/Waveform";
import type { Meeting } from "@/lib/demo-data";
import { getSpeaker } from "@/lib/demo-data";
import { SPEAKER_STYLES, speakerBarColor } from "@/lib/display";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";

export function TimelineDock({ meeting }: { meeting: Meeting }) {
  const currentMs = usePlayerStore((state) => state.currentMs);
  const durationMs = usePlayerStore((state) => state.durationMs);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const togglePlaying = usePlayerStore((state) => state.togglePlaying);
  const seek = usePlayerStore((state) => state.seek);

  const bands: WaveBand[] = meeting.transcripts.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    tone: getSpeaker(meeting, segment.speakerId).tone,
  }));

  const noteMarkers: WaveMarker[] = meeting.notes.map((note, index) => ({
    id: note.id,
    startMs: note.startMs,
    kind: note.kind === "decision" ? "decision" : note.kind === "bookmark" ? "bookmark" : "note",
    label: `N #${index + 1} · ${formatTimestamp(note.startMs)} · ${note.text}`,
  }));

  const screenshotMarkers: WaveMarker[] = meeting.screenshots.map((screenshot, index) => ({
    id: screenshot.id,
    startMs: screenshot.startMs,
    kind: "screenshot",
    label: `Screenshot ${index + 1} · ${formatTimestamp(screenshot.startMs)} · ${screenshot.title}`,
  }));

  return (
    <footer
      aria-label="Meeting timeline and playback"
      className="h-[88px] shrink-0 border-t border-border-subtle bg-[color-mix(in_oklch,var(--brand-bg-elevated)_35%,var(--brand-bg-primary))]"
    >
      <div className="grid h-full grid-cols-[190px_minmax(0,1fr)_250px] gap-0">
        <div className="flex min-w-0 flex-col justify-center gap-1.5 border-r border-border-subtle px-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={togglePlaying}
              aria-label={isPlaying ? "Pause playback" : "Play recording"}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-primary text-bg-primary shadow-[inset_0_1px_0_oklch(1_0_0/0.16)] transition hover:brightness-110"
            >
              {isPlaying ? (
                <Pause className="size-3.5 fill-current" />
              ) : (
                <Play className="ml-0.5 size-3.5 fill-current" />
              )}
            </button>
            <div className="min-w-0">
              <p className="tabular text-[11px] font-medium text-text-primary">
                {formatTimestamp(currentMs)}
                <span className="ml-1 text-[9px] font-normal text-text-muted">
                  / {formatTimestamp(durationMs || meeting.durationMs)}
                </span>
              </p>
              <p className="flex items-center gap-1 text-[8.5px] text-text-muted">
                <Captions className="size-2.5" />
                {meeting.transcripts.length} segments
                <span className="text-border-subtle">·</span>
                2ch
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[8px] text-text-muted/65">
            <ShieldCheck className="size-2.5 text-accent-primary" />
            local playback · no network
          </div>
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-1 px-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[8px] font-semibold uppercase tracking-[0.12em] text-text-muted/75">
              Timeline
            </span>
            <div className="flex items-center gap-2.5">
              {meeting.participants.map((speaker) => (
                <span
                  key={speaker.id}
                  className="flex items-center gap-1 text-[8px] text-text-muted/75"
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: speakerBarColor(speaker.tone) }}
                  />
                  {speaker.name}
                </span>
              ))}
              <span className="flex items-center gap-1 text-[8px] text-text-muted/60">
                <Flag className="size-2.5" /> {meeting.notes.length} notes
              </span>
            </div>
          </div>
          <Waveform
            durationMs={durationMs || meeting.durationMs}
            currentMs={currentMs}
            bands={bands}
            markers={[...noteMarkers, ...screenshotMarkers]}
            onSeek={seek}
            height={34}
            bars={180}
          />
          <div className="flex items-center gap-2 text-[7.5px] text-text-muted/60">
            <span className="flex items-center gap-1">
              <span className="size-1.5 rotate-45 rounded-[1px] border border-accent-primary bg-accent-primary" />
              decision
            </span>
            <span className="flex items-center gap-1">
              <span className="size-1.5 rotate-45 rounded-[1px] border border-accent-secondary bg-accent-secondary" />
              slide
            </span>
            <span className="flex items-center gap-1">
              <span className="size-1.5 rotate-45 rounded-[1px] border border-border-subtle bg-text-muted" />
              note
            </span>
            <span className="ml-auto hidden items-center gap-1 sm:flex">
              <span
                className={cn(
                  "size-1 rounded-full",
                  isPlaying ? "bg-recording-pulse" : "bg-text-muted/40",
                )}
              />
              {isPlaying ? "playing" : "paused"}
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-1.5 border-l border-border-subtle px-3">
          <div className="flex items-center justify-between text-[8px] text-text-muted/75">
            <span className="flex items-center gap-1 uppercase tracking-[0.12em]">
              <Layers className="size-2.5" />
              Slides
            </span>
            <span className="flex items-center gap-1">
              <Camera className="size-2.5" />
              {meeting.screenshots.length} captured
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {meeting.screenshots.map((screenshot) => (
              <button
                key={screenshot.id}
                type="button"
                onClick={() => seek(screenshot.startMs)}
                title={`${screenshot.title} · ${formatTimestamp(screenshot.startMs)}`}
                aria-label={`Seek to slide ${screenshot.title} at ${formatTimestamp(screenshot.startMs)}`}
                className="group relative w-[66px] shrink-0 overflow-hidden rounded-[4px] border border-border-subtle transition hover:border-accent-secondary/45"
              >
                <SlideThumbnail
                  screenshot={screenshot}
                  compact
                  showTime={false}
                  className="rounded-none border-0"
                />
                <span className="tabular absolute bottom-0 left-0 right-0 bg-black/55 px-1 py-px text-left text-[6.5px] text-white">
                  {formatTimestamp(screenshot.startMs)}
                </span>
              </button>
            ))}
            <span className="ml-1 flex flex-col items-center justify-center gap-0.5 text-[7px] text-text-muted/55">
              <LayerGlyph />
              dHash
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}

function LayerGlyph() {
  return (
    <span className="flex -space-x-1">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="block size-2 rounded-[1px] border border-border-subtle bg-bg-elevated"
          style={{ transform: `rotate(${index * 8 - 8}deg)` }}
        />
      ))}
    </span>
  );
}
