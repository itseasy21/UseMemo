"use client";

import Link from "next/link";
import { ArrowUpRight, AudioWaveform, Mic, ShieldCheck, Sparkles } from "lucide-react";

import { LocalRecordings } from "@/components/home/LocalRecordings";
import { AppShell } from "@/components/shell/AppShell";
import { buttonClass } from "@/components/ui/Button";
import { useWorkspaceStore } from "@/stores/workspace";

export function Dashboard() {
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);

  return (
    <AppShell rightMode="home">
      <div className="mx-auto w-full max-w-[1080px] px-5 pb-20 pt-6 sm:px-8 lg:px-10">
        <section className="relative mb-9 overflow-hidden rounded-[28px] border border-[var(--glass-border)] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--brand-bg-elevated)_98%,transparent),color-mix(in_oklab,var(--brand-bg-elevated)_88%,var(--brand-accent-secondary)_12%))] px-6 py-7 shadow-[var(--glass-shadow-lg)] sm:px-8 sm:py-9">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-24 -top-32 size-[420px] rounded-full bg-accent-primary/10 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-40 right-24 size-[360px] rounded-full bg-accent-secondary/10 blur-3xl"
          />

          <div className="relative grid items-center gap-8 2xl:grid-cols-[1.15fr_0.85fr]">
            <div>
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-accent-primary/20 bg-accent-primary/[0.08] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-primary">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                Local-first meeting intelligence
              </div>
              <h1 className="max-w-[620px] text-[clamp(2rem,4vw,3.65rem)] font-semibold leading-[0.98] tracking-[-0.055em] text-text-primary">
                Meetings in.
                <span className="block bg-gradient-to-r from-accent-primary to-accent-secondary bg-clip-text text-transparent">
                  Clarity out.
                </span>
              </h1>
              <p className="mt-5 max-w-[590px] text-[14px] leading-6 text-text-muted sm:text-[15px]">
                Capture every voice, turn conversations into grounded notes, and keep the entire
                workflow private on your device.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={openNewRecording}
                  className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-accent-primary to-accent-secondary px-5 text-sm font-semibold text-[#06110f] shadow-[0_16px_40px_-18px_color-mix(in_oklab,var(--brand-accent-primary)_90%,transparent)] transition hover:-translate-y-0.5 hover:brightness-105"
                >
                  <Mic className="size-4" aria-hidden="true" />
                  Start recording
                </button>
                <Link
                  href="/models/"
                  className={buttonClass({
                    variant: "secondary",
                    size: "lg",
                    className: "h-11 rounded-xl px-4",
                  })}
                >
                  <Sparkles className="size-4 text-accent-secondary" aria-hidden="true" />
                  Explore local AI
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </Link>
              </div>
            </div>

            <div className="relative mx-auto flex w-full max-w-[380px] items-center justify-center">
              <div className="absolute inset-x-8 top-1/2 h-px bg-gradient-to-r from-transparent via-accent-primary/40 to-transparent" />
              <div className="relative w-full rounded-[24px] border border-white/10 bg-[#071216]/90 p-5 shadow-[0_30px_80px_-32px_rgba(0,0,0,.8)]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-10 items-center justify-center rounded-2xl bg-gradient-to-br from-accent-primary/25 to-accent-secondary/20 text-accent-primary">
                      <AudioWaveform className="size-5" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold text-white">Live capture</p>
                      <p className="text-[10px] uppercase tracking-[0.12em] text-white/45">
                        On-device processing
                      </p>
                    </div>
                  </div>
                  <span className="flex items-center gap-1.5 rounded-full bg-recording-pulse/12 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-recording-pulse">
                    <span className="size-1.5 animate-pulse rounded-full bg-recording-pulse" />
                    Ready
                  </span>
                </div>
                <div className="mt-8 flex h-20 items-center justify-center gap-1">
                  {[18, 34, 58, 28, 72, 46, 84, 38, 64, 26, 52, 22, 40, 16].map((height, index) => (
                    <span
                      key={`${height}-${index}`}
                      className="w-1.5 rounded-full bg-gradient-to-t from-accent-secondary to-accent-primary"
                      style={{ height: `${height}%`, opacity: 0.45 + (index % 4) * 0.15 }}
                    />
                  ))}
                </div>
                <div className="mt-7 grid grid-cols-3 gap-2">
                  {["Transcript", "Speakers", "Summary"].map((label) => (
                    <div
                      key={label}
                      className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-2 py-2.5 text-center text-[10px] font-medium text-white/65"
                    >
                      {label}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent-primary">
              Your vault
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.035em] text-text-primary">
              Recent conversations
            </h2>
          </div>
          <button
            type="button"
            onClick={openNewRecording}
            className="hidden h-9 items-center gap-2 rounded-xl border border-[var(--glass-border-strong)] bg-[var(--glass-surface)] px-3.5 text-xs font-semibold text-text-primary transition hover:border-accent-primary/35 hover:bg-accent-primary/[0.06] sm:inline-flex"
          >
            <Mic className="size-3.5 text-accent-primary" aria-hidden="true" />
            New recording
          </button>
        </div>

        <LocalRecordings />
      </div>
    </AppShell>
  );
}
