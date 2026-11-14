"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Radio, RotateCcw, UserRound } from "lucide-react";

import { ScreenshotCard } from "@/components/meeting/ScreenshotCard";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Pill";
import { Popover } from "@/components/ui/Popover";
import {
  getScreenshot,
  getSpeaker,
  type Meeting,
  type Speaker,
  type TranscriptSegment,
} from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { speakerLabel, useWorkspaceStore } from "@/stores/workspace";

function SpeakerPill({
  meeting,
  speaker,
  segment,
}: {
  meeting: Meeting;
  speaker: Speaker;
  segment: TranscriptSegment;
}) {
  const labels = useWorkspaceStore((state) => state.speakerLabels);
  const setSpeakerLabel = useWorkspaceStore((state) => state.setSpeakerLabel);
  const resetSpeakerLabel = useWorkspaceStore((state) => state.resetSpeakerLabel);
  const label = speakerLabel(labels, meeting.id, speaker.id, speaker.name);
  const [draft, setDraft] = useState(label);

  useEffect(() => {
    setDraft(label);
  }, [label]);

  return (
    <Popover
      label={`Rename speaker ${label}`}
      align="start"
      panelClassName="w-[236px]"
      trigger={(props) => (
        <button
          {...props}
          title="Rename speaker"
          className={cn(
            "inline-flex max-w-[180px] items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium transition hover:brightness-110",
            speaker.tone === "accent" &&
              "border-accent-primary/25 bg-accent-primary/10 text-accent-primary",
            speaker.tone === "secondary" &&
              "border-accent-secondary/25 bg-accent-secondary/10 text-accent-secondary",
            speaker.tone === "warm" &&
              "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
            speaker.tone === "violet" &&
              "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
          )}
        >
          <Avatar name={label} tone={speaker.tone} size="xs" className="size-4 text-[7px]" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-2.5 opacity-60" />
        </button>
      )}
    >
      {(close) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const next = draft.trim();
            if (next && next !== speaker.name) {
              setSpeakerLabel(meeting.id, speaker.id, next);
            } else if (!next || next === speaker.name) {
              resetSpeakerLabel(meeting.id, speaker.id);
            }
            close();
          }}
        >
          <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold text-text-primary">
            <UserRound className="size-3 text-text-muted" />
            Speaker label
          </p>
          <p className="mb-2 text-[8.5px] leading-4 text-text-muted">
            Detected as {speaker.name} · {speaker.role}
          </p>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
            aria-label="Speaker name"
            className="h-7 w-full rounded-[5px] border border-border-subtle bg-bg-primary/50 px-2 text-[11px] text-text-primary outline-none focus:border-accent-primary/50"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                resetSpeakerLabel(meeting.id, speaker.id);
                setDraft(speaker.name);
                close();
              }}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[9px] text-text-muted transition hover:text-text-primary"
            >
              <RotateCcw className="size-2.5" /> Reset
            </button>
            <button
              type="submit"
              className="inline-flex h-6 items-center rounded-[5px] bg-accent-primary px-2 text-[9px] font-medium text-bg-primary"
            >
              Save label
            </button>
          </div>
          <p className="mt-2 truncate border-t border-border-subtle pt-1.5 font-mono text-[7.5px] text-text-muted/60">
            segment {segment.id} · voiceprint local
          </p>
        </form>
      )}
    </Popover>
  );
}

function SegmentCard({
  meeting,
  segment,
  active,
  onHover,
}: {
  meeting: Meeting;
  segment: TranscriptSegment;
  active: boolean;
  onHover: (id: string | null) => void;
}) {
  const seek = usePlayerStore((state) => state.seek);
  const speaker = getSpeaker(meeting, segment.speakerId);
  const screenshot = segment.screenshotId
    ? getScreenshot(meeting, segment.screenshotId)
    : undefined;

  return (
    <article
      id={`transcript-${segment.id}`}
      onMouseEnter={() => onHover(segment.id)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "relative scroll-mt-4 rounded-[7px] border border-transparent px-2 py-2 transition-colors",
        active
          ? "border-accent-primary/20 bg-accent-primary/[0.045]"
          : "hover:border-border-subtle hover:bg-bg-elevated/35",
      )}
    >
      <div className="flex gap-2.5">
        <div className="flex w-9 shrink-0 flex-col items-end pt-0.5">
          <button
            type="button"
            onClick={() => seek(segment.startMs)}
            aria-label={`Seek to ${formatTimestamp(segment.startMs)}`}
            title="Seek playhead"
            className={cn(
              "tabular rounded px-1 py-0.5 text-[8.5px] transition hover:bg-bg-elevated hover:text-text-primary",
              active ? "text-accent-primary" : "text-text-muted",
            )}
          >
            {formatTimestamp(segment.startMs)}
          </button>
          <span
            className={cn(
              "mt-1 h-full min-h-3 w-px flex-1 rounded",
              active ? "bg-accent-primary/35" : "bg-border-subtle",
            )}
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <SpeakerPill meeting={meeting} speaker={speaker} segment={segment} />
            <span className="text-[8px] text-text-muted/70">{speaker.role}</span>
            {segment.live ? (
              <Pill
                tone="danger"
                className="gap-1 px-1.5 py-0"
                icon={<span className="size-1 animate-pulse rounded-full bg-recording-pulse" />}
              >
                streaming
              </Pill>
            ) : (
              <span className="ml-auto flex items-center gap-1 text-[8px] text-text-muted/60">
                <Check className="size-2.5 text-accent-primary/70" />
                confirmed
              </span>
            )}
          </div>
          <p className="mt-1 text-[11.5px] leading-[1.65] text-text-primary/90">
            {segment.confirmedText}
            {segment.unconfirmedText && (
              <span className="ml-1 italic text-text-muted/75">{segment.unconfirmedText}</span>
            )}
            {segment.live && (
              <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-accent-primary align-middle" />
            )}
          </p>
          {segment.unconfirmedText && !segment.live && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-border-subtle px-1.5 py-px text-[7.5px] uppercase tracking-[0.08em] text-text-muted">
              unconfirmed delta
            </span>
          )}
          {screenshot && <ScreenshotCard screenshot={screenshot} className="mt-2" />}
        </div>
      </div>
    </article>
  );
}

export function TranscriptPane({
  meeting,
  activeSegmentId,
}: {
  meeting: Meeting;
  activeSegmentId: string | null;
}) {
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const [follow, setFollow] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    if (!follow || !isPlaying || !activeSegmentId) return;
    const element = document.getElementById(`transcript-${activeSegmentId}`);
    element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSegmentId, follow, isPlaying]);

  const live = meeting.transcripts[meeting.transcripts.length - 1]?.live;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-primary">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle px-3.5 text-[9px] text-text-muted">
        <Radio className="size-2.5" />
        <span className="font-medium text-text-primary">Diarized stream</span>
        <span className="text-border-subtle">·</span>
        <span>{meeting.transcripts.length} segments · 3 speakers</span>
        <button
          type="button"
          onClick={() => setFollow((value) => !value)}
          aria-pressed={follow}
          className={cn(
            "ml-auto inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[8px] transition",
            follow
              ? "border-accent-primary/25 bg-accent-primary/[0.07] text-accent-primary"
              : "border-border-subtle text-text-muted hover:text-text-primary",
          )}
        >
          <span
            className={cn("size-1 rounded-full", follow ? "bg-accent-primary" : "bg-text-muted/40")}
          />
          Follow playhead
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-0.5">
          {meeting.transcripts.map((segment) => (
            <SegmentCard
              key={segment.id}
              meeting={meeting}
              segment={segment}
              active={activeSegmentId === segment.id}
              onHover={setHoveredId}
            />
          ))}
        </div>
        <div className="flex items-center justify-center gap-1.5 py-3 text-[8.5px] text-text-muted/70">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-recording-pulse opacity-40" />
            <span className="relative inline-flex size-1.5 rounded-full bg-recording-pulse" />
          </span>
          ASR listening · local 640 ms window
          {live ? " · live segment above" : ""}
          {hoveredId ? "" : ""}
        </div>
      </div>
    </div>
  );
}
