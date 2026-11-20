"use client";

import { useState } from "react";
import { Play, Pause, Camera, Layers, Loader2 } from "lucide-react";

import { SlideThumbnail } from "@/components/ui/SlideThumbnail";
import { Waveform, type WaveBand, type WaveMarker } from "@/components/ui/Waveform";
import type { Meeting } from "@/lib/demo-data";
import { getSpeaker } from "@/lib/demo-data";
import { speakerBarColor } from "@/lib/display";
import { formatTimestamp } from "@/lib/format";
import { captureScreenshot } from "@/lib/host";
import { formatHostError, isTauri } from "@/lib/tauri";
import { usePlayerStore } from "@/stores/player";
import { useWorkspaceStore } from "@/stores/workspace";

export function TimelineDock({
  meeting,
  onReload,
}: {
  meeting: Meeting;
  onReload?: () => Promise<void>;
}) {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const currentMs = usePlayerStore((state) => state.currentMs);
  const durationMs = usePlayerStore((state) => state.durationMs);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const playbackRate = usePlayerStore((state) => state.playbackRate);
  const cyclePlaybackRate = usePlayerStore((state) => state.cyclePlaybackRate);
  const togglePlaying = usePlayerStore((state) => state.togglePlaying);
  const seek = usePlayerStore((state) => state.seek);
  const [snapping, setSnapping] = useState(false);

  const effectiveDuration = Math.max(durationMs, meeting.durationMs);

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

  const handleManualSnap = async () => {
    if (snapping) return;
    if (!isTauri() || meeting.isDemo) {
      pushToast(
        "Screenshot marker",
        "Manual WebP capture runs inside the Tauri desktop app.",
        "accent",
      );
      return;
    }
    setSnapping(true);
    try {
      const outcome = await captureScreenshot(meeting.id);
      if (outcome?.deduplicated) {
        pushToast("Slide unchanged", outcome.reason, "default");
      } else {
        await onReload?.();
        pushToast("Slide captured", "Saved locally as WebP and linked to timeline.", "success");
      }
    } catch (error) {
      pushToast("Could not capture screenshot", formatHostError(error), "danger");
    } finally {
      setSnapping(false);
    }
  };

  return (
    <footer
      aria-label="Meeting timeline and playback"
      className="shrink-0 border-t border-[var(--glass-border)] bg-[var(--glass-surface)] px-4 py-2.5 backdrop-blur-2xl"
    >
      <div className="flex flex-wrap items-center gap-4">
        {/* Play/Pause + Time + Speed */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlaying}
            disabled={effectiveDuration <= 0}
            aria-label={isPlaying ? "Pause playback" : "Play recording"}
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-primary text-bg-primary shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_28%,transparent),0_4px_14px_-2px_color-mix(in_oklab,var(--brand-accent-primary)_45%,transparent)] transition hover:scale-105 hover:brightness-105 disabled:opacity-40"
          >
            {isPlaying ? (
              <Pause className="size-4 fill-current" aria-hidden="true" />
            ) : (
              <Play className="ml-0.5 size-4 fill-current" aria-hidden="true" />
            )}
          </button>

          <div>
            <p className="tabular text-[13px] font-semibold text-text-primary">
              {formatTimestamp(currentMs)}
              <span className="ml-1 text-xs font-normal text-text-muted">
                / {formatTimestamp(effectiveDuration)}
              </span>
            </p>
            <div className="mt-0.5 flex items-center gap-2">
              {meeting.participants.slice(0, 3).map((speaker) => (
                <span
                  key={speaker.id}
                  className="flex items-center gap-1 text-[10.5px] text-text-muted"
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: speakerBarColor(speaker.tone) }}
                  />
                  {speaker.name}
                </span>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={cyclePlaybackRate}
            aria-label={`Playback speed ${playbackRate}x. Click to change speed.`}
            className="glass-subtle tabular flex h-7 shrink-0 items-center justify-center rounded-lg px-2 text-[11px] font-medium text-text-muted transition hover:text-text-primary"
          >
            {playbackRate}×
          </button>
        </div>

        {/* Interactive Waveform Scrubber */}
        <div className="min-w-[200px] flex-1">
          <Waveform
            durationMs={effectiveDuration}
            currentMs={currentMs}
            bands={bands}
            markers={[...noteMarkers, ...screenshotMarkers]}
            onSeek={seek}
            height={36}
            bars={150}
          />
        </div>

        {/* Slide Filmstrip & Manual Snap */}
        <div className="hidden items-center gap-2 lg:flex">
          {meeting.screenshots.length > 0 && (
            <div className="flex max-w-[220px] items-center gap-1.5 overflow-x-auto py-0.5">
              {meeting.screenshots.map((screenshot) => (
                <button
                  key={screenshot.id}
                  type="button"
                  onClick={() => seek(screenshot.startMs)}
                  title={`${screenshot.title} · ${formatTimestamp(screenshot.startMs)}`}
                  aria-label={`Seek to slide ${screenshot.title} at ${formatTimestamp(screenshot.startMs)}`}
                  className="group relative w-[58px] shrink-0 overflow-hidden rounded-lg border border-[var(--glass-border)] transition hover:border-accent-secondary/50"
                >
                  <SlideThumbnail
                    screenshot={screenshot}
                    compact
                    showTime={false}
                    className="rounded-none border-0"
                  />
                  <span className="tabular absolute bottom-0 left-0 right-0 bg-black/65 px-1 py-px text-left text-[9px] text-white">
                    {formatTimestamp(screenshot.startMs)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleManualSnap()}
            disabled={snapping}
            aria-label="Capture manual screenshot"
            className="glass-subtle inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-text-muted transition hover:border-accent-secondary/40 hover:text-text-primary disabled:opacity-50"
          >
            {snapping ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Camera className="size-3.5 text-accent-secondary" aria-hidden="true" />
            )}
            <span>Snap Slide</span>
            {meeting.screenshots.length > 0 && (
              <span className="tabular flex items-center gap-0.5 text-[10.5px] text-text-muted/75">
                <Layers className="size-3" aria-hidden="true" />
                {meeting.screenshots.length}
              </span>
            )}
          </button>
        </div>
      </div>
    </footer>
  );
}
