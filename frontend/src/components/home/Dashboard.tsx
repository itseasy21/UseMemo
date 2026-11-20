"use client";

import { useState } from "react";
import Link from "next/link";
import { Mic, Radio, X } from "lucide-react";

import { LocalRecordings } from "@/components/home/LocalRecordings";
import { AppShell } from "@/components/shell/AppShell";
import { buttonClass } from "@/components/ui/Button";
import { useWorkspaceStore } from "@/stores/workspace";

export function Dashboard() {
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  return (
    <AppShell rightMode="home">
      <div className="mx-auto w-full max-w-[820px] px-5 pb-16 pt-4 sm:px-7">
        {/* Otter-style Top Dismissible Banner */}
        {!bannerDismissed && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--glass-border-strong)] bg-[var(--glass-surface-strong)] px-4 py-2.5 shadow-sm backdrop-blur-xl">
            <div className="flex min-w-0 items-center gap-2.5 text-xs text-text-primary">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-primary/20 text-accent-primary">
                <Radio className="size-3.5" aria-hidden="true" />
              </span>
              <span className="truncate font-medium">
                Record microphone + system audio with automatic slide snapshots and 100% offline AI
                notes.
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/models/"
                className={buttonClass({
                  variant: "outline",
                  size: "xs",
                  className: "rounded-full px-3",
                })}
              >
                AI Models
              </Link>
              <button
                type="button"
                onClick={openNewRecording}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-text-primary px-3 text-xs font-semibold text-bg-primary transition hover:opacity-90"
              >
                <Mic className="size-3" aria-hidden="true" />
                Start Recording
              </button>
              <button
                type="button"
                onClick={() => setBannerDismissed(true)}
                aria-label="Dismiss banner"
                className="ml-1 flex size-6 items-center justify-center rounded-full text-text-muted transition hover:text-text-primary"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        <LocalRecordings />
      </div>
    </AppShell>
  );
}
