"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Circle, Loader2, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useSynthesisProgress } from "@/hooks/use-host-event";
import type { Meeting } from "@/lib/demo-data";
import { synthesizeMeeting } from "@/lib/host";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

const STAGES = [
  { id: "assembling", label: "Assembling", detail: "context + sources" },
  { id: "inferencing", label: "Inferencing", detail: "local SLM" },
  { id: "verifying", label: "Verifying", detail: "evidence gates" },
  { id: "complete", label: "Complete", detail: "vault write" },
] as const;

const STREAM_TEXT = [
  "indexing transcript 01–16 · notes 01–09 · slides 01–03",
  'inference: "The team is holding a six-week runway. Billing migration is the critical path…"',
  "claim 12/12 · transcript evidence 9 · note evidence 7 · slide evidence 4 · owners resolve 6/8",
  "verified 12/12 claims · 0 blocked · synthesis written to use_memo_vault.db",
];

function stageIndexFor(stage: string): number {
  switch (stage) {
    case "context":
      return 0;
    case "generating":
      return 1;
    case "verifying":
      return 2;
    default:
      return 3;
  }
}

export function SynthesisProgress({ meeting }: { meeting: Meeting }) {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const [run, setRun] = useState({ progress: 100, stageIndex: 3, running: false });
  const [stream, setStream] = useState<string | null>(null);
  const completedRef = useRef(true);
  const hostDriven = useRef(false);

  useSynthesisProgress((payload) => {
    if (payload.meetingId !== meeting.id) return;
    hostDriven.current = true;
    setRun({
      progress: payload.percent,
      stageIndex: stageIndexFor(payload.stage),
      running: payload.stage !== "complete" && payload.stage !== "failed",
    });
    if (payload.message) setStream(payload.message);
  });

  useEffect(() => {
    if (!run.running || hostDriven.current) return;
    const timer = window.setInterval(() => {
      setRun((previous) => {
        if (!previous.running) return previous;
        const next = Math.min(100, previous.progress + 6.4);
        const stageIndex = next >= 100 ? 3 : next >= 72 ? 2 : next >= 28 ? 1 : 0;
        return { progress: next, stageIndex, running: next < 100 };
      });
    }, 360);
    return () => window.clearInterval(timer);
  }, [run.running]);

  useEffect(() => {
    if (run.progress < 100 || run.running || completedRef.current) return;
    completedRef.current = true;
    if (hostDriven.current) return;
    pushToast(
      "Synthesis verified locally",
      `${meeting.summary.groundedClaims}/${meeting.summary.totalClaims} claims grounded · 0 blocked · no network calls`,
      "success",
    );
  }, [
    meeting.summary.groundedClaims,
    meeting.summary.totalClaims,
    pushToast,
    run.progress,
    run.running,
  ]);

  const start = () => {
    completedRef.current = false;
    setStream(null);
    if (!isTauri()) {
      hostDriven.current = false;
      setRun({ progress: 2, stageIndex: 0, running: true });
      return;
    }

    hostDriven.current = true;
    setRun({ progress: 0, stageIndex: 0, running: true });
    void synthesizeMeeting(meeting.id).then((result) => {
      if (!result) {
        hostDriven.current = false;
        setRun((previous) => ({ ...previous, running: false }));
        pushToast(
          "Synthesis could not run",
          "The local LiteRT-LM worker is not ready. Install a model in Model Studio and retry.",
          "danger",
        );
        return;
      }
      setRun({ progress: 100, stageIndex: 3, running: false });
      pushToast(
        "Synthesis verified locally",
        `${result.report.keptItems} kept · ${result.report.forcedUnassignedOwners} owners forced to Unassigned · ${result.report.forcedUnspecifiedDeadlines} deadlines forced to Not specified`,
        "success",
      );
    });
  };

  return (
    <section aria-label="Synthesis pipeline status" className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <span className="flex size-7 items-center justify-center rounded-[7px] border border-accent-primary/25 bg-accent-primary/10 text-accent-primary">
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[12px] font-semibold text-text-primary">Grounded synthesis</h2>
            <Pill tone="accent" icon={<ShieldCheck className="size-2.5" />}>
              fail-closed verifier
            </Pill>
            <Pill tone="outline">gemma-4-E4B-it.litertlm</Pill>
          </div>
          <p className="mt-0.5 truncate font-mono text-[8.5px] text-text-muted">
            {run.progress >= 100
              ? `${meeting.summary.groundedClaims}/${meeting.summary.totalClaims} claims grounded · 0 blocked`
              : (stream ?? STREAM_TEXT[run.stageIndex])}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="tabular text-[13px] font-medium text-text-primary">
            {Math.round(run.progress)}%
          </span>
          <Button
            variant="secondary"
            size="xs"
            leading={<RefreshCw className={cn("size-3", run.running && "animate-spin")} />}
            onClick={start}
            disabled={run.running}
          >
            {run.running ? "Synthesizing" : "Re-synthesize"}
          </Button>
        </div>
      </div>

      <div className="grid gap-0 border-t border-border-subtle sm:grid-cols-4">
        {STAGES.map((stage, index) => {
          const done = run.stageIndex > index || run.progress >= 100;
          const active = run.stageIndex === index && run.running;
          return (
            <div
              key={stage.id}
              className={cn(
                "flex items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0",
                active && "bg-accent-primary/[0.045]",
              )}
              aria-current={active ? "step" : undefined}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full border",
                  done
                    ? "border-accent-primary/30 bg-accent-primary/12 text-accent-primary"
                    : active
                      ? "border-accent-primary/35 bg-accent-primary/10 text-accent-primary"
                      : "border-border-subtle text-text-muted/50",
                )}
              >
                {done ? (
                  <Check className="size-2.5" />
                ) : active ? (
                  <Loader2 className="size-2.5 animate-spin" />
                ) : (
                  <Circle className="size-1.5 fill-current" />
                )}
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-[9.5px] font-medium leading-3",
                    done || active ? "text-text-primary" : "text-text-muted",
                  )}
                >
                  {stage.label}
                </p>
                <p className="truncate text-[7.5px] text-text-muted/65">{stage.detail}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-3.5 pb-2.5 pt-1.5">
        <ProgressBar
          value={run.progress}
          label="Synthesis progress"
          size="xs"
          tone={run.progress >= 100 ? "accent" : "secondary"}
        />
      </div>
    </section>
  );
}
