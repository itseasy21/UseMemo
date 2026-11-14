"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, CheckCircle2, Mic, MonitorUp, ShieldCheck } from "lucide-react";

import { LocalRecordings } from "@/components/home/LocalRecordings";
import { AppShell } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { openHud } from "@/lib/hud";
import { useWorkspaceStore } from "@/stores/workspace";

export function Dashboard() {
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[980px] px-6 pb-16 pt-10 sm:px-10 lg:pt-14">
        <header className="max-w-[680px]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
            Local workspace
          </p>
          <h1 className="mt-3 text-[32px] font-semibold leading-[1.08] tracking-[-0.04em] text-text-primary sm:text-[38px]">
            Your recordings
          </h1>
          <p className="mt-3 max-w-[560px] text-[14.5px] leading-6 text-text-muted">
            Record a conversation and keep the useful parts. Everything stays on this Mac.
          </p>
        </header>

        <section className="mt-8 overflow-hidden rounded-[20px] border border-border-subtle bg-bg-elevated">
          <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-accent-primary/20 bg-accent-primary/[0.08] text-accent-primary">
              <Mic className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-text-primary">
                Start a recording
              </h2>
              <p className="mt-1 max-w-[500px] text-[13px] leading-5 text-text-muted">
                The microphone is on by default. You can add system audio, screenshots, or speaker
                labels before you start.
              </p>
            </div>
            <Button
              variant="primary"
              size="lg"
              className="w-full justify-center sm:w-auto"
              leading={<Mic className="size-3.5" />}
              trailing={
                <Kbd className="border-bg-primary/20 bg-bg-primary/15 text-bg-primary">⌘N</Kbd>
              }
              onClick={openNewRecording}
            >
              New recording
            </Button>
          </div>

          <div className="flex flex-col gap-3 border-t border-border-subtle bg-bg-primary/25 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="flex items-center gap-2 text-[12px] text-text-muted">
              <ShieldCheck className="size-3.5 shrink-0 text-accent-primary" />
              Audio and notes stay on this Mac.
            </p>
            <button
              type="button"
              onClick={() => void openHud()}
              className="flex w-fit items-center gap-1.5 text-[12px] font-medium text-text-muted transition hover:text-text-primary"
            >
              <MonitorUp className="size-3.5" />
              Open floating recorder
              <ArrowUpRight className="size-3" />
            </button>
          </div>
        </section>

        <LocalRecordings />

        <footer className="mt-8 flex flex-col items-start justify-between gap-3 border-t border-border-subtle pt-5 text-[12px] text-text-muted sm:flex-row sm:items-center">
          <p className="flex items-center gap-2">
            <CheckCircle2 className="size-3.5 text-accent-primary" />
            No account. No cloud. No upload.
          </p>
          <Link
            href="/models/"
            className="flex items-center gap-1.5 font-medium transition hover:text-text-primary"
          >
            Manage AI models
            <ArrowRight className="size-3" />
          </Link>
        </footer>
      </div>
    </AppShell>
  );
}
