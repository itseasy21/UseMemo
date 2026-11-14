"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  Camera,
  Check,
  CheckCheck,
  CircleDot,
  Cpu,
  Fingerprint,
  Gauge,
  Layers,
  ListChecks,
  LockKeyhole,
  PencilLine,
  ShieldCheck,
  Sparkles,
  UserRoundX,
} from "lucide-react";

import { EvidencePreview } from "@/components/synthesis/EvidencePreview";
import { EvidenceChips } from "@/components/synthesis/EvidenceChip";
import { SynthesisProgress } from "@/components/synthesis/SynthesisProgress";
import { StudioHeader } from "@/components/meeting/StudioHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Pill";
import { SlideThumbnail } from "@/components/ui/SlideThumbnail";
import {
  getSpeaker,
  meetingActionOwner,
  type ActionItem,
  type Decision,
  type EvidenceRef,
  type Meeting,
} from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { synthesisItemIsFocused, useSynthesisStore, type SynthesisFocus } from "@/stores/synthesis";
import { speakerLabel, useWorkspaceStore } from "@/stores/workspace";

function useItemFocus(itemId: string, evidence: EvidenceRef[]) {
  const focus = useSynthesisStore((state) => state.focus);
  const setFocus = useSynthesisStore((state) => state.setFocus);
  const clearFocusIf = useSynthesisStore((state) => state.clearFocusIf);
  const target: SynthesisFocus = { kind: "synthesis", id: itemId, evidence };
  return {
    focused: synthesisItemIsFocused(focus, itemId, evidence),
    bind: {
      onMouseEnter: () => setFocus(target),
      onMouseLeave: () => clearFocusIf(target),
      onFocus: () => setFocus(target),
      onBlur: () => clearFocusIf(target),
    },
  };
}

function SummaryParagraph({
  meeting,
  id,
  text,
  evidence,
}: {
  meeting: Meeting;
  id: string;
  text: string;
  evidence: EvidenceRef[];
}) {
  const { focused, bind } = useItemFocus(`summary-${id}`, evidence);
  return (
    <div
      {...bind}
      tabIndex={0}
      aria-label={text}
      className={cn(
        "rounded-[6px] border border-transparent px-2.5 py-2 text-[11.5px] leading-[1.75] text-text-primary/85 outline-none transition-colors",
        focused
          ? "border-accent-primary/25 bg-accent-primary/[0.055]"
          : "hover:border-border-subtle hover:bg-bg-elevated/35",
      )}
    >
      {text}
      <EvidenceChips meeting={meeting} evidence={evidence} className="mt-1.5" />
    </div>
  );
}

function DecisionRow({
  meeting,
  decision,
  index,
}: {
  meeting: Meeting;
  decision: Decision;
  index: number;
}) {
  const { focused, bind } = useItemFocus(decision.id, decision.evidence);
  return (
    <div
      {...bind}
      tabIndex={0}
      aria-label={`Decision ${index + 1}: ${decision.text}`}
      className={cn(
        "rounded-[6px] border border-transparent px-2.5 py-2.5 outline-none transition-colors",
        focused
          ? "border-accent-primary/25 bg-accent-primary/[0.055]"
          : "hover:border-border-subtle hover:bg-bg-elevated/35",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "tabular mt-px flex size-5 shrink-0 items-center justify-center rounded-[4px] border text-[8px] font-semibold",
            focused
              ? "border-accent-primary/35 bg-accent-primary/10 text-accent-primary"
              : "border-border-subtle bg-bg-primary/40 text-text-muted",
          )}
        >
          D{index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium leading-[1.6] text-text-primary">{decision.text}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <EvidenceChips meeting={meeting} evidence={decision.evidence} />
            {decision.userEdited && (
              <Pill tone="warning" className="gap-1" icon={<PencilLine className="size-2.5" />}>
                User Edited
              </Pill>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionRow({
  meeting,
  action,
  done,
  edited,
  onToggle,
}: {
  meeting: Meeting;
  action: ActionItem;
  done: boolean;
  edited: boolean;
  onToggle: () => void;
}) {
  const labels = useWorkspaceStore((state) => state.speakerLabels);
  const owner = meetingActionOwner(meeting, action);
  const ownerName = owner ? speakerLabel(labels, meeting.id, owner.id, owner.name) : null;
  const { focused, bind } = useItemFocus(action.id, action.evidence);

  return (
    <div
      {...bind}
      className={cn(
        "grid min-w-[720px] grid-cols-[26px_minmax(0,1fr)_122px_96px_200px] items-center gap-x-2 border-b border-border-subtle/70 px-3 py-2.5 transition-colors last:border-b-0",
        focused ? "bg-accent-primary/[0.045]" : "hover:bg-bg-elevated/30",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={`${done ? "Mark incomplete" : "Mark complete"}: ${action.task}`}
        onClick={onToggle}
        className={cn(
          "flex size-4 items-center justify-center rounded-[4px] border transition",
          done
            ? "border-accent-primary bg-accent-primary text-bg-primary"
            : "border-border-subtle bg-bg-primary/35 text-transparent hover:border-accent-primary/45",
        )}
      >
        <Check className="size-2.5" />
      </button>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <p
            className={cn(
              "text-[10.5px] font-medium leading-[1.5]",
              done ? "text-text-muted line-through decoration-text-muted/40" : "text-text-primary",
            )}
          >
            {action.task}
          </p>
          {edited && (
            <Pill
              tone="warning"
              className="gap-1 px-1.5"
              icon={<PencilLine className="size-2.5" />}
            >
              User Edited
            </Pill>
          )}
        </div>
      </div>
      <div className="min-w-0">
        {owner && ownerName ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle bg-bg-elevated/55 px-1.5 py-0.5">
            <Avatar name={ownerName} tone={owner.tone} size="xs" className="size-3.5 text-[6px]" />
            <span className="truncate text-[8.5px] text-text-primary/85">{ownerName}</span>
          </span>
        ) : (
          <span
            title="The verifier will not invent an owner"
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-amber-500/30 px-1.5 py-0.5 text-[8.5px] text-amber-700 dark:text-amber-300"
          >
            <UserRoundX className="size-2.5" />
            Unassigned
          </span>
        )}
      </div>
      <div className="min-w-0">
        {action.deadline ? (
          <span className="tabular inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-primary/30 px-1.5 py-0.5 text-[8px] text-text-muted">
            <CalendarClock className="size-2.5" />
            {action.deadline}
          </span>
        ) : (
          <span
            title="No deadline was grounded in the transcript"
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-subtle px-1.5 py-0.5 text-[8px] text-text-muted"
          >
            Not specified
          </span>
        )}
      </div>
      <EvidenceChips meeting={meeting} evidence={action.evidence} />
    </div>
  );
}

function SlideEvidenceCard({
  meeting,
  screenshot,
}: {
  meeting: Meeting;
  screenshot: Meeting["screenshots"][number];
}) {
  const { focused, bind } = useItemFocus(`slide-${screenshot.id}`, [
    { kind: "screenshot", id: screenshot.id },
  ]);
  const seek = usePlayerStore((state) => state.seek);
  const setFocus = useSynthesisStore((state) => state.setFocus);

  return (
    <button
      type="button"
      {...bind}
      onClick={() => {
        setFocus({ kind: "screenshot", id: screenshot.id });
        seek(screenshot.startMs);
      }}
      aria-label={`Trace slide ${screenshot.title} at ${formatTimestamp(screenshot.startMs)}`}
      className={cn(
        "group rounded-[5px] border p-1 text-left transition",
        focused
          ? "border-accent-primary/45 bg-accent-primary/[0.06]"
          : "border-border-subtle bg-bg-primary/25 hover:border-text-muted/30",
      )}
    >
      <SlideThumbnail screenshot={screenshot} compact showTime={false} className="border-0" />
      <div className="mt-1 flex items-center gap-1.5">
        <span className="tabular text-[7.5px] text-text-muted">
          {formatTimestamp(screenshot.startMs)}
        </span>
        <span className="truncate text-[8px] text-text-muted">{screenshot.title}</span>
        <ArrowUpRight className="ml-auto size-2.5 text-text-muted/40 group-hover:text-accent-primary" />
      </div>
    </button>
  );
}

function VerificationCard({ meeting }: { meeting: Meeting }) {
  const total = meeting.actions.length;
  const unassigned = meeting.actions.filter((action) => !action.ownerId).length;
  const missingDeadlines = meeting.actions.filter((action) => !action.deadline).length;
  const edited =
    meeting.actions.filter((action) => action.userEdited).length +
    meeting.decisions.filter((decision) => decision.userEdited).length;
  const confidence = Math.round(meeting.summary.confidence * 100);
  const slm = "gemma-4-E4B-it.litertlm";

  return (
    <section
      aria-labelledby="verification-heading"
      className="panel flex flex-col p-4 lg:col-span-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2
            id="verification-heading"
            className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
          >
            <Gauge className="size-3.5 text-accent-primary" />
            Verifier
          </h2>
          <p className="mt-0.5 text-[8.5px] text-text-muted">fail-closed · deterministic gates</p>
        </div>
        <Pill tone="accent" icon={<LockKeyhole className="size-2.5" />}>
          air-gapped
        </Pill>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div
          className="relative flex size-[74px] shrink-0 items-center justify-center rounded-full"
          style={{
            background: `conic-gradient(var(--brand-accent-primary) ${confidence * 3.6}deg, var(--brand-border-subtle) 0deg)`,
          }}
          role="img"
          aria-label={`Synthesis confidence ${confidence}%`}
        >
          <div className="absolute inset-[5px] flex flex-col items-center justify-center rounded-full bg-bg-elevated">
            <span className="tabular text-[15px] font-medium leading-none text-text-primary">
              {confidence}%
            </span>
            <span className="mt-0.5 text-[6.5px] uppercase tracking-[0.1em] text-text-muted">
              grounded
            </span>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="tabular text-[10px] font-medium text-text-primary">
            {meeting.summary.groundedClaims}/{meeting.summary.totalClaims} claims verified
          </p>
          <p className="text-[8.5px] leading-4 text-text-muted">
            Every summary, decision, and action row carries at least one source citation.
          </p>
          <p className="flex items-center gap-1 font-mono text-[7.5px] text-text-muted/65">
            <Cpu className="size-2.5" />
            {slm}
          </p>
        </div>
      </div>

      <dl className="mt-3 space-y-1.5 border-t border-border-subtle pt-2.5">
        {[
          {
            label: "Evidence coverage",
            value: `${meeting.summary.groundedClaims}/${meeting.summary.totalClaims}`,
            ok: true,
          },
          {
            label: "Owner resolution",
            value: `${total - unassigned}/${total}`,
            ok: unassigned === 0,
          },
          {
            label: "Deadline resolution",
            value: `${total - missingDeadlines}/${total}`,
            ok: missingDeadlines === 0,
          },
          { label: "User-edited claims", value: String(edited), ok: edited === 0 },
        ].map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2 text-[8.5px]">
            <dt className="flex items-center gap-1.5 text-text-muted">
              {row.ok ? (
                <CheckCheck className="size-2.5 text-accent-primary" />
              ) : (
                <AlertTriangle className="size-2.5 text-amber-600 dark:text-amber-300" />
              )}
              {row.label}
            </dt>
            <dd className="tabular text-text-primary/80">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-auto flex items-center gap-1.5 pt-2.5 text-[7.5px] text-text-muted/60">
        <Fingerprint className="size-2.5" />
        SHA-256 manifest · notes + artifacts · source-linked export
      </div>
    </section>
  );
}

export function SynthesisCanvas({ meeting }: { meeting: Meeting }) {
  const initialize = usePlayerStore((state) => state.initialize);
  const clearFocus = useSynthesisStore((state) => state.clearFocus);
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const [doneState, setDoneState] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(meeting.actions.map((action) => [action.id, Boolean(action.done)])),
  );
  const [editedState, setEditedState] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(meeting.actions.map((action) => [action.id, Boolean(action.userEdited)])),
  );

  useEffect(() => {
    initialize(meeting.durationMs, 0);
    return () => clearFocus();
  }, [clearFocus, initialize, meeting.durationMs]);

  const toggleAction = (action: ActionItem) => {
    const nextDone = !doneState[action.id];
    setDoneState((current) => ({ ...current, [action.id]: nextDone }));
    setEditedState((current) => ({ ...current, [action.id]: true }));
    pushToast(
      nextDone ? "Action marked done" : "Action reopened",
      "Local edit recorded · row carries a [User Edited] state",
      "success",
    );
  };

  const doneCount = Object.values(doneState).filter(Boolean).length;

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden bg-bg-primary">
      <StudioHeader meeting={meeting} mode="synthesis" />
      <div className="min-h-0 flex-1 overflow-y-auto xl:overflow-hidden">
        <div className="mx-auto flex max-w-[1540px] flex-col gap-3 px-3 py-3 xl:h-full xl:flex-row xl:px-4">
          <main className="min-w-0 flex-1 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
            <div className="pb-1">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-1.5 text-[8.5px] font-semibold uppercase tracking-[0.16em] text-text-muted">
                    <Sparkles className="size-2.5 text-accent-primary" />
                    Local synthesis · {meeting.summary.groundedClaims}/{meeting.summary.totalClaims}{" "}
                    grounded
                  </p>
                  <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.035em] text-text-primary">
                    Every claim carries a receipt.
                  </h1>
                  <p className="mt-1 max-w-[620px] text-[11px] leading-5 text-text-muted">
                    Hover any row to trace its transcript, note, and slide evidence. Missing owners
                    and deadlines are surfaced, never guessed.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone="accent" icon={<ShieldCheck className="size-2.5" />}>
                    {meeting.summary.groundedClaims}/{meeting.summary.totalClaims} verified
                  </Pill>
                  <Pill tone="outline" icon={<Layers className="size-2.5" />}>
                    {meeting.notes.length + meeting.transcripts.length + meeting.screenshots.length}{" "}
                    sources
                  </Pill>
                  <Pill tone="outline" icon={<Fingerprint className="size-2.5" />}>
                    local hash
                  </Pill>
                </div>
              </div>

              <SynthesisProgress meeting={meeting} />

              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-6">
                <section aria-labelledby="summary-heading" className="panel p-4 lg:col-span-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2
                        id="summary-heading"
                        className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                      >
                        <Sparkles className="size-3.5 text-accent-primary" />
                        Executive Summary
                      </h2>
                      <p className="mt-0.5 text-[8.5px] text-text-muted">
                        Generated from this room · structured, verified, local
                      </p>
                    </div>
                    <Pill tone="accent">E4B</Pill>
                  </div>
                  <p className="mt-3 text-[14px] font-medium leading-[1.4] tracking-[-0.02em] text-text-primary">
                    {meeting.summary.headline}
                  </p>
                  <div className="mt-1.5 space-y-0.5">
                    {meeting.summary.paragraphs.map((paragraph) => (
                      <SummaryParagraph
                        key={paragraph.id}
                        meeting={meeting}
                        id={paragraph.id}
                        text={paragraph.text}
                        evidence={paragraph.evidence}
                      />
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border-subtle pt-2.5">
                    <CircleDot className="size-2.5 text-accent-primary" />
                    <span className="text-[8.5px] text-text-muted">
                      {meeting.summary.keyPoints.join(" · ")}
                    </span>
                  </div>
                </section>

                <VerificationCard meeting={meeting} />

                <section aria-labelledby="decisions-heading" className="panel p-4 lg:col-span-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h2
                        id="decisions-heading"
                        className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                      >
                        <ShieldCheck className="size-3.5 text-accent-secondary" />
                        Decisions Register
                      </h2>
                      <p className="mt-0.5 text-[8.5px] text-text-muted">
                        Locked decisions with source citations · {meeting.decisions.length} items
                      </p>
                    </div>
                    <Pill tone="outline">D1–D{meeting.decisions.length}</Pill>
                  </div>
                  <div className="mt-2.5 space-y-0.5">
                    {meeting.decisions.map((decision, index) => (
                      <DecisionRow
                        key={decision.id}
                        meeting={meeting}
                        decision={decision}
                        index={index}
                      />
                    ))}
                  </div>
                </section>

                <section aria-labelledby="slides-heading" className="panel p-4 lg:col-span-2">
                  <div className="flex items-center justify-between">
                    <h2
                      id="slides-heading"
                      className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                    >
                      <Camera className="size-3.5 text-text-muted" />
                      Slide evidence
                    </h2>
                    <Pill tone="secondary">{meeting.screenshots.length} OCR</Pill>
                  </div>
                  <p className="mt-0.5 text-[8.5px] text-text-muted">
                    Vision captions indexed for synthesis
                  </p>
                  <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                    {meeting.screenshots.map((screenshot) => (
                      <SlideEvidenceCard
                        key={screenshot.id}
                        meeting={meeting}
                        screenshot={screenshot}
                      />
                    ))}
                  </div>
                  <p className="mt-2 text-[8px] leading-4 text-text-muted/70">
                    Screenshot intervals are deduped by dHash before they enter the evidence index.
                  </p>
                </section>

                <section
                  aria-labelledby="actions-heading"
                  className="panel overflow-hidden lg:col-span-6"
                >
                  <header className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <h2
                        id="actions-heading"
                        className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                      >
                        <ListChecks className="size-3.5 text-amber-600 dark:text-amber-300" />
                        Action Items
                      </h2>
                      <p className="mt-0.5 text-[8.5px] text-text-muted">
                        Verified owner &amp; deadline gates · {doneCount}/{meeting.actions.length}{" "}
                        done
                      </p>
                    </div>
                    <Pill tone="warning" className="gap-1">
                      <UserRoundX className="size-2.5" />
                      {meeting.actions.filter((action) => !action.ownerId).length} unassigned
                    </Pill>
                    <Pill tone="outline">
                      {meeting.actions.filter((action) => !action.deadline).length} no deadline
                    </Pill>
                    <Pill
                      tone="success"
                      className="gap-1"
                      icon={<CheckCheck className="size-2.5" />}
                    >
                      evidence complete
                    </Pill>
                  </header>
                  <div className="hidden min-w-[720px] grid-cols-[26px_minmax(0,1fr)_122px_96px_200px] gap-x-2 border-b border-border-subtle bg-bg-primary/25 px-3 py-1.5 text-[7.5px] font-semibold uppercase tracking-[0.12em] text-text-muted lg:grid">
                    <span aria-hidden="true">Done</span>
                    <span>Action</span>
                    <span>Owner</span>
                    <span>Due</span>
                    <span>Evidence</span>
                  </div>
                  <div className="overflow-x-auto">
                    {meeting.actions.map((action) => (
                      <ActionRow
                        key={action.id}
                        meeting={meeting}
                        action={action}
                        done={Boolean(doneState[action.id])}
                        edited={Boolean(editedState[action.id])}
                        onToggle={() => toggleAction(action)}
                      />
                    ))}
                  </div>
                  <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-4 py-2 text-[8px] text-text-muted/70">
                    <span className="flex items-center gap-1.5">
                      <AlertTriangle className="size-2.5 text-amber-600 dark:text-amber-300" />
                      Unassigned and Not specified are verifier outcomes, not omissions.
                    </span>
                    <span className="font-mono">edits stay local · [User Edited]</span>
                  </footer>
                </section>
              </div>

              <div className="mt-3 xl:hidden">
                <EvidencePreview meeting={meeting} className="h-[480px]" />
              </div>

              <footer className="flex flex-wrap items-center justify-between gap-2 px-1 pb-3 pt-4 text-[8.5px] text-text-muted/60">
                <span>
                  Generated on this machine · {formatTimestamp(meeting.durationMs)} of source ·{" "}
                  {meeting.participants.length} speakers
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-1 rounded-full bg-accent-primary" />
                  no network request was made
                </span>
              </footer>
            </div>
          </main>

          <EvidencePreview meeting={meeting} className="hidden h-full w-[372px] shrink-0 xl:flex" />
        </div>
      </div>
    </div>
  );
}
