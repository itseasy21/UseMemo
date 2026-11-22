"use client";

import { MeetingStudio } from "@/components/meeting/MeetingStudio";
import type { Meeting } from "@/lib/demo-data";

export function SynthesisCanvas({
  meeting,
  onReload,
  onMutate,
}: {
  meeting: Meeting;
  onReload?: () => Promise<void>;
  onMutate?: (updater: (current: Meeting) => Meeting) => void;
}) {
  return (
    <MeetingStudio meeting={meeting} initialTab="summary" onReload={onReload} onMutate={onMutate} />
  );
}
