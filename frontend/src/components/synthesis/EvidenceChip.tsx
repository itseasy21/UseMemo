"use client";

import {
  evidenceDomId,
  evidenceExcerpt,
  evidenceLabel,
  evidenceTime,
  type EvidenceRef,
  type Meeting,
} from "@/lib/demo-data";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { useSynthesisStore } from "@/stores/synthesis";

export function EvidenceChip({
  meeting,
  evidence,
  className,
}: {
  meeting: Meeting;
  evidence: EvidenceRef;
  className?: string;
}) {
  const focus = useSynthesisStore((state) => state.focus);
  const setFocus = useSynthesisStore((state) => state.setFocus);
  const clearFocusIf = useSynthesisStore((state) => state.clearFocusIf);
  const seek = usePlayerStore((state) => state.seek);

  const label = evidenceLabel(meeting, evidence);
  const active = focus?.kind === evidence.kind && focus.id === evidence.id;
  const [prefix, ...rest] = label.split(" ");
  const target = { kind: evidence.kind, id: evidence.id } as const;

  const activate = () => {
    setFocus(target);
    seek(evidenceTime(meeting, evidence));
    const element = document.getElementById(evidenceDomId(meeting.id, evidence));
    element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  return (
    <button
      type="button"
      onClick={activate}
      onMouseEnter={() => setFocus(target)}
      onMouseLeave={() => clearFocusIf(target)}
      onFocus={() => setFocus(target)}
      onBlur={() => clearFocusIf(target)}
      title={`${evidenceExcerpt(meeting, evidence)} · trace evidence`}
      aria-label={`Evidence ${label}: ${evidenceExcerpt(meeting, evidence)}`}
      className={cn(
        "tabular inline-flex h-[18px] shrink-0 items-center rounded-[4px] border px-1 font-mono text-[8.5px] leading-none transition-colors",
        active
          ? "border-accent-primary/45 bg-accent-primary/15 text-accent-primary"
          : "border-border-subtle bg-bg-primary/35 text-text-muted hover:border-accent-primary/30 hover:text-text-primary",
        className,
      )}
    >
      <span aria-hidden="true" className="opacity-45">
        [
      </span>
      <span
        className={cn("font-semibold", active ? "text-accent-primary" : "text-accent-secondary")}
      >
        {prefix}
      </span>
      <span className="ml-0.5">{rest.join(" ")}</span>
      <span aria-hidden="true" className="opacity-45">
        ]
      </span>
    </button>
  );
}

export function EvidenceChips({
  meeting,
  evidence,
  className,
}: {
  meeting: Meeting;
  evidence: EvidenceRef[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {evidence.map((ref) => (
        <EvidenceChip key={`${ref.kind}-${ref.id}`} meeting={meeting} evidence={ref} />
      ))}
    </div>
  );
}
