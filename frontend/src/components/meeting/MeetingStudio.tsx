"use client";

import { useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { AudioMeterHeader } from "@/components/meeting/AudioMeterHeader";
import { NotesEditor } from "@/components/meeting/NotesEditor";
import { StudioHeader } from "@/components/meeting/StudioHeader";
import { TimelineDock } from "@/components/meeting/TimelineDock";
import { TranscriptPane } from "@/components/meeting/TranscriptPane";
import type { Meeting } from "@/lib/demo-data";
import { SEEK_HANDOFF_PREFIX, STUDIO_LAYOUT_KEY } from "@/lib/session-keys";
import { usePlayerStore } from "@/stores/player";

export function MeetingStudio({ meeting }: { meeting: Meeting }) {
  const initialize = usePlayerStore((state) => state.initialize);
  const tick = usePlayerStore((state) => state.tick);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const togglePlaying = usePlayerStore((state) => state.togglePlaying);
  const currentMs = usePlayerStore((state) => state.currentMs);

  useEffect(() => {
    let startMs = meeting.transcripts[Math.floor(meeting.transcripts.length / 2)]?.startMs ?? 0;
    try {
      const key = `${SEEK_HANDOFF_PREFIX}${meeting.id}`;
      const handoff = window.sessionStorage.getItem(key);
      if (handoff) {
        const parsed = Number(handoff);
        if (Number.isFinite(parsed)) startMs = parsed;
        window.sessionStorage.removeItem(key);
      }
    } catch {
      // A missing sessionStorage is fine; start at the demo midpoint.
    }
    initialize(meeting.durationMs, startMs);
  }, [initialize, meeting.durationMs, meeting.id, meeting.transcripts]);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => tick(250), 250);
    return () => window.clearInterval(timer);
  }, [isPlaying, tick]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']") ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      togglePlaying();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlaying]);

  const activeSegment =
    [...meeting.transcripts].reverse().find((segment) => segment.startMs <= currentMs) ??
    meeting.transcripts[0];
  const activeSegmentId = activeSegment?.id ?? null;
  const activeSpeakerId = activeSegment?.speakerId ?? null;

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden bg-bg-primary">
      <StudioHeader meeting={meeting} mode="studio" />
      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId={STUDIO_LAYOUT_KEY} className="h-full">
          <Panel defaultSize={55} minSize={34} className="min-w-0">
            <div className="h-full border-r border-border-subtle">
              <NotesEditor meeting={meeting} />
            </div>
          </Panel>
          <PanelResizeHandle
            className="group relative z-10 w-px bg-border-subtle transition-colors hover:bg-accent-primary/50 focus-visible:bg-accent-primary data-[resize-handle-state=drag]:bg-accent-primary"
            aria-label="Resize notes and transcript panes"
          >
            <span className="absolute inset-y-0 -left-1 -right-1" />
            <span className="absolute left-1/2 top-1/2 h-8 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-subtle opacity-0 transition group-hover:opacity-100" />
          </PanelResizeHandle>
          <Panel defaultSize={45} minSize={30} className="min-w-0">
            <div className="flex h-full min-w-0 flex-col">
              <AudioMeterHeader
                meeting={meeting}
                activeSpeakerId={activeSpeakerId}
                currentMs={currentMs}
              />
              <TranscriptPane meeting={meeting} activeSegmentId={activeSegmentId} />
            </div>
          </Panel>
        </PanelGroup>
      </div>
      <TimelineDock meeting={meeting} />
    </div>
  );
}
