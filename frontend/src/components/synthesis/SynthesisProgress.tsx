"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";

import { Button, buttonClass } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useSynthesisProgress } from "@/hooks/use-host-event";
import type { Meeting } from "@/lib/demo-data";
import { synthesizeMeeting, type SynthesisResponse } from "@/lib/host";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

const STREAM_TEXT = [
  "Assembling transcript, notes, and slide captures…",
  "Running on-device AI summary model…",
  "Verifying source citations and action items…",
  "AI summary saved to local vault.",
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

export function SynthesisProgress({
  meeting,
  onSynthesized,
}: {
  meeting: Meeting;
  onSynthesized?: (result: SynthesisResponse) => Promise<void> | void;
}) {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const hasExistingItems = meeting.summary.totalClaims > 0;
  const [run, setRun] = useState({
    progress: hasExistingItems ? 100 : 0,
    stageIndex: hasExistingItems ? 3 : 0,
    running: false,
  });
  const [stream, setStream] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const completedRef = useRef(true);
  const hostDriven = useRef(false);

  useEffect(() => {
    if (!run.running) {
      const done = meeting.summary.totalClaims > 0;
      setRun({ progress: done ? 100 : 0, stageIndex: done ? 3 : 0, running: false });
    }
  }, [meeting.summary.totalClaims, run.running]);

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
      "AI Summary verified",
      `${meeting.summary.groundedClaims}/${meeting.summary.totalClaims} claims grounded with citations`,
      "success",
    );
  }, [
    meeting.summary.groundedClaims,
    meeting.summary.totalClaims,
    pushToast,
    run.progress,
    run.running,
  ]);

  const start = async () => {
    completedRef.current = false;
    setStream(null);
    setErrorMessage(null);

    if (!isTauri() || meeting.isDemo) {
      hostDriven.current = false;
      setRun({ progress: 2, stageIndex: 0, running: true });
      return;
    }

    hostDriven.current = true;
    setRun({ progress: 5, stageIndex: 0, running: true });
    try {
      const result = await synthesizeMeeting(meeting.id);
      if (!result) {
        setRun((previous) => ({ ...previous, running: false }));
        return;
      }
      await onSynthesized?.(result);
      setRun({ progress: 100, stageIndex: 3, running: false });
      pushToast(
        "AI Summary ready",
        `${result.report.keptItems} verified items generated locally`,
        "success",
      );
    } catch (error) {
      const msg = formatHostError(error);
      hostDriven.current = false;
      setErrorMessage(msg);
      setRun((previous) => ({ ...previous, running: false }));
      pushToast("Summary could not run", msg, "danger");
    }
  };

  const modelBadge = meeting.slmModelId || "Local LLM";

  return (
    <section aria-label="AI Summary status" className="panel overflow-hidden p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-accent-primary/30 bg-accent-primary/14 text-accent-primary">
            {run.running ? (
              <Loader2 className="size-4.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-4.5" aria-hidden="true" />
            )}
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[14px] font-semibold text-text-primary">
                On-Device Meeting Intelligence
              </h2>
              <Pill tone="accent" icon={<ShieldCheck className="size-3" />}>
                Citation-verified
              </Pill>
              <Pill tone="neutral">{modelBadge}</Pill>
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              {run.running
                ? (stream ?? STREAM_TEXT[run.stageIndex])
                : hasExistingItems
                  ? `${meeting.summary.groundedClaims} verified claims linked to transcript, notes, and slides`
                  : "Generate an executive summary, decisions, and action items from your recording."}
            </p>
          </div>
        </div>

        <Button
          variant={hasExistingItems ? "secondary" : "primary"}
          size="sm"
          leading={<RefreshCw className={cn("size-3.5", run.running && "animate-spin")} />}
          onClick={() => void start()}
          disabled={run.running}
        >
          {run.running ? "Generating…" : hasExistingItems ? "Regenerate" : "Generate Summary"}
        </Button>
      </div>

      {run.running && (
        <div className="mt-3.5">
          <ProgressBar value={run.progress} label="Synthesis progress" size="xs" tone="accent" />
        </div>
      )}

      {errorMessage && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-recording-pulse/30 bg-recording-pulse/[0.08] px-3.5 py-2.5 text-xs text-recording-pulse">
          <span>{errorMessage}</span>
          <Link href="/models/" className={buttonClass({ variant: "secondary", size: "xs" })}>
            Open AI Models
          </Link>
        </div>
      )}
    </section>
  );
}
