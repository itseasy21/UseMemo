"use client";

import { AudioLines, Camera, FileText, MousePointer2, NotebookPen, Quote } from "lucide-react";

import { Pill } from "@/components/ui/Pill";
import { SlideThumbnail } from "@/components/ui/SlideThumbnail";
import { evidenceDomId, getSpeaker, type Meeting } from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { useSynthesisStore, type SynthesisFocus } from "@/stores/synthesis";
import { speakerLabel, useWorkspaceStore } from "@/stores/workspace";

function isHighlighted(
  focus: SynthesisFocus | null,
  kind: "transcript" | "note" | "screenshot",
  id: string,
): boolean {
  if (!focus) return false;
  if (focus.kind === kind) return focus.id === id;
  if (focus.kind === "synthesis") {
    return focus.evidence.some((evidence) => evidence.kind === kind && evidence.id === id);
  }
  return false;
}

export function EvidencePreview({ meeting, className }: { meeting: Meeting; className?: string }) {
  const focus = useSynthesisStore((state) => state.focus);
  const setFocus = useSynthesisStore((state) => state.setFocus);
  const clearFocusIf = useSynthesisStore((state) => state.clearFocusIf);
  const seek = usePlayerStore((state) => state.seek);
  const labels = useWorkspaceStore((state) => state.speakerLabels);

  return (
    <aside
      aria-label="Source evidence preview"
      className={cn("panel flex min-h-0 flex-col overflow-hidden", className)}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3.5 py-2.5">
        <Quote className="size-3.5 text-accent-secondary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[11px] font-semibold text-text-primary">Evidence preview</h2>
          <p className="text-[8.5px] text-text-muted">Hover a claim · click a chip to trace it</p>
        </div>
        <Pill tone={focus ? "accent" : "outline"} className="gap-1">
          <MousePointer2 className="size-2.5" />
          {focus ? "tracing" : "idle"}
        </Pill>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <section aria-labelledby="preview-transcript">
          <div className="flex items-center justify-between px-1.5 py-1">
            <h3
              id="preview-transcript"
              className="flex items-center gap-1.5 text-[8.5px] font-semibold uppercase tracking-[0.14em] text-text-muted"
            >
              <AudioLines className="size-2.5" />
              Transcript
            </h3>
            <span className="tabular text-[8px] text-text-muted/60">
              {meeting.transcripts.length} segments
            </span>
          </div>
          <div className="space-y-0.5">
            {meeting.transcripts.map((segment) => {
              const speaker = getSpeaker(meeting, segment.speakerId);
              const name = speakerLabel(labels, meeting.id, speaker.id, speaker.name);
              const highlighted = isHighlighted(focus, "transcript", segment.id);
              const target = { kind: "transcript", id: segment.id } as const;
              return (
                <button
                  type="button"
                  key={segment.id}
                  id={evidenceDomId(meeting.id, { kind: "transcript", id: segment.id })}
                  onMouseEnter={() => setFocus(target)}
                  onMouseLeave={() => clearFocusIf(target)}
                  onFocus={() => setFocus(target)}
                  onBlur={() => clearFocusIf(target)}
                  onClick={() => {
                    setFocus(target);
                    seek(segment.startMs);
                  }}
                  aria-label={`Transcript at ${formatTimestamp(segment.startMs)}, ${name}: ${segment.confirmedText}`}
                  className={cn(
                    "w-full rounded-[5px] border border-transparent px-1.5 py-1.5 text-left transition-colors",
                    highlighted
                      ? "border-accent-primary/25 bg-accent-primary/[0.06]"
                      : "hover:bg-bg-elevated/55",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "tabular text-[8px]",
                        highlighted ? "text-accent-primary" : "text-text-muted",
                      )}
                    >
                      {formatTimestamp(segment.startMs)}
                    </span>
                    <span className="truncate text-[8.5px] font-medium text-text-primary/85">
                      {name}
                    </span>
                    <span className="ml-auto shrink-0 rounded border border-border-subtle px-1 py-px text-[6.5px] uppercase tracking-[0.06em] text-text-muted/60">
                      T
                    </span>
                  </div>
                  <p
                    className={cn(
                      "mt-0.5 line-clamp-2 text-[9.5px] leading-[1.55]",
                      highlighted ? "text-text-primary" : "text-text-muted",
                    )}
                  >
                    {segment.confirmedText}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        <section
          aria-labelledby="preview-notes"
          className="mt-2 border-t border-border-subtle pt-2"
        >
          <div className="flex items-center justify-between px-1.5 py-1">
            <h3
              id="preview-notes"
              className="flex items-center gap-1.5 text-[8.5px] font-semibold uppercase tracking-[0.14em] text-text-muted"
            >
              <NotebookPen className="size-2.5" />
              Notes
            </h3>
            <span className="tabular text-[8px] text-text-muted/60">
              {meeting.notes.length} lines
            </span>
          </div>
          <div className="space-y-0.5">
            {meeting.notes.map((note, index) => {
              const highlighted = isHighlighted(focus, "note", note.id);
              const target = { kind: "note", id: note.id } as const;
              return (
                <button
                  type="button"
                  key={note.id}
                  id={evidenceDomId(meeting.id, { kind: "note", id: note.id })}
                  onMouseEnter={() => setFocus(target)}
                  onMouseLeave={() => clearFocusIf(target)}
                  onFocus={() => setFocus(target)}
                  onBlur={() => clearFocusIf(target)}
                  onClick={() => {
                    setFocus(target);
                    seek(note.startMs);
                  }}
                  aria-label={`Note ${index + 1} at ${formatTimestamp(note.startMs)}: ${note.text}`}
                  className={cn(
                    "flex w-full items-start gap-1.5 rounded-[5px] border border-transparent px-1.5 py-1.5 text-left transition-colors",
                    highlighted
                      ? "border-accent-primary/25 bg-accent-primary/[0.06]"
                      : "hover:bg-bg-elevated/55",
                  )}
                >
                  <span className="tabular mt-0.5 flex shrink-0 items-center gap-1 text-[8px] text-text-muted">
                    <span className={cn(highlighted && "text-accent-primary")}>#{index + 1}</span>
                    <span className="text-[7.5px] opacity-60">{formatTimestamp(note.startMs)}</span>
                  </span>
                  <span
                    className={cn(
                      "line-clamp-2 text-[9.5px] leading-[1.55]",
                      highlighted ? "text-text-primary" : "text-text-muted",
                    )}
                  >
                    {note.text}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section
          aria-labelledby="preview-slides"
          className="mt-2 border-t border-border-subtle pt-2"
        >
          <div className="flex items-center justify-between px-1.5 py-1">
            <h3
              id="preview-slides"
              className="flex items-center gap-1.5 text-[8.5px] font-semibold uppercase tracking-[0.14em] text-text-muted"
            >
              <Camera className="size-2.5" />
              Slides
            </h3>
            <span className="tabular text-[8px] text-text-muted/60">
              {meeting.screenshots.length} captured
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1.5 px-1">
            {meeting.screenshots.map((screenshot) => {
              const highlighted = isHighlighted(focus, "screenshot", screenshot.id);
              const target = { kind: "screenshot", id: screenshot.id } as const;
              return (
                <button
                  type="button"
                  key={screenshot.id}
                  id={evidenceDomId(meeting.id, { kind: "screenshot", id: screenshot.id })}
                  onMouseEnter={() => setFocus(target)}
                  onMouseLeave={() => clearFocusIf(target)}
                  onFocus={() => setFocus(target)}
                  onBlur={() => clearFocusIf(target)}
                  onClick={() => {
                    setFocus(target);
                    seek(screenshot.startMs);
                  }}
                  aria-label={`Slide ${screenshot.title} at ${formatTimestamp(screenshot.startMs)}`}
                  className={cn(
                    "rounded-[4px] p-px transition",
                    highlighted
                      ? "bg-accent-primary/50 ring-1 ring-accent-primary/30"
                      : "bg-transparent hover:bg-border-subtle",
                  )}
                >
                  <SlideThumbnail
                    screenshot={screenshot}
                    compact
                    showTime={false}
                    className="border-0"
                  />
                  <span className="tabular mt-0.5 block text-center text-[6.5px] text-text-muted">
                    {formatTimestamp(screenshot.startMs)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle bg-bg-primary/25 px-3.5 py-1.5 text-[7.5px] text-text-muted/70">
        <span className="flex items-center gap-1">
          <FileText className="size-2.5" />
          {meeting.transcripts.length} T · {meeting.notes.length} N · {meeting.screenshots.length} S
        </span>
        <span className="font-mono">source-linked · local</span>
      </footer>
    </aside>
  );
}
