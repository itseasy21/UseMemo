"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  History,
  ListChecks,
  Mic,
  MonitorUp,
  Search,
  ShieldCheck,
} from "lucide-react";

import { LocalRecordings } from "@/components/home/LocalRecordings";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, AvatarStack } from "@/components/ui/Avatar";
import { buttonClass } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { MEETINGS, PENDING_ACTIONS, VAULT_STATS, type Meeting } from "@/lib/demo-data";
import { formatDuration } from "@/lib/format";
import { openHud } from "@/lib/hud";
import { useWorkspaceStore } from "@/stores/workspace";

function MeetingRow({ meeting }: { meeting: Meeting }) {
  const pending = meeting.actions.filter((action) => !action.done).length;

  return (
    <Link
      href={`/meeting/${meeting.id}/`}
      className="group flex items-center gap-3 border-b border-border-subtle/70 px-5 py-4 transition-colors last:border-b-0 hover:bg-bg-elevated/40 sm:gap-4"
    >
      <span className="hidden size-10 shrink-0 items-center justify-center rounded-[10px] border border-border-subtle bg-bg-primary/40 text-text-muted sm:flex">
        <AudioLines className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-text-primary">
          {meeting.title}
        </h3>
        <p className="mt-0.5 truncate text-[13px] text-text-muted">{meeting.summary.headline}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-muted">
          <span>{meeting.dateLabel}</span>
          <span className="text-border-subtle">·</span>
          <span>{formatDuration(meeting.durationMs)}</span>
          {pending > 0 ? (
            <>
              <span className="text-border-subtle">·</span>
              <span>
                {pending} open {pending === 1 ? "step" : "steps"}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <span className="hidden shrink-0 sm:block">
        <AvatarStack people={meeting.participants} size="xs" max={3} />
      </span>
      <ChevronRight className="size-4 shrink-0 text-text-muted/40 transition group-hover:translate-x-0.5 group-hover:text-text-muted" />
    </Link>
  );
}

export function Dashboard() {
  const openPalette = useWorkspaceStore((state) => state.openPalette);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const [showAllSteps, setShowAllSteps] = useState(false);

  const latest = MEETINGS[0];
  const latestPending = latest.actions.filter((action) => !action.done).length;
  const visibleSteps = showAllSteps ? PENDING_ACTIONS : PENDING_ACTIONS.slice(0, 4);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1180px] px-5 pb-16 pt-7 sm:px-8 lg:pt-10">
        <section className="relative overflow-hidden rounded-[20px] border border-border-subtle bg-[radial-gradient(120%_140%_at_0%_0%,color-mix(in_oklch,var(--brand-accent-primary)_11%,transparent),transparent_60%)] p-6 sm:p-8 lg:p-10">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full bg-accent-primary/[0.06] blur-3xl"
          />
          <div className="relative flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-center sm:gap-10">
            <div className="max-w-[560px]">
              <Pill tone="accent" className="text-[11px]" icon={<ShieldCheck className="size-3" />}>
                Private by design
              </Pill>
              <h1 className="mt-4 text-[32px] font-semibold leading-[1.08] tracking-[-0.04em] text-text-primary sm:text-[40px]">
                Every conversation,
                <br className="hidden sm:block" /> remembered.
              </h1>
              <p className="mt-3 max-w-[500px] text-[14.5px] leading-6 text-text-muted">
                Record a meeting and get a clear summary, decisions, and next steps. Everything is
                transcribed and organized on this Mac.
              </p>
              <p className="mt-4 flex items-center gap-2 text-[12px] text-text-muted">
                <CheckCircle2 className="size-3.5 shrink-0 text-accent-primary" />
                {VAULT_STATS.memoCount} memos and {VAULT_STATS.capturedHours} hours, stored only on
                this Mac.
              </p>
              <button
                type="button"
                onClick={() => void openHud()}
                className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-text-muted transition hover:text-text-primary"
              >
                <MonitorUp className="size-3.5" />
                Open floating recorder
                <ArrowUpRight className="size-3" />
              </button>
            </div>

            <div className="relative mx-auto flex shrink-0 items-center justify-center py-4 sm:mx-0 sm:mr-2 lg:mr-8">
              <span
                aria-hidden="true"
                className="absolute size-52 rounded-full border border-accent-primary/15 sm:size-64"
              />
              <span
                aria-hidden="true"
                className="absolute size-40 rounded-full border border-accent-primary/20 sm:size-52"
              />
              <button
                type="button"
                onClick={openNewRecording}
                aria-label="Start a new recording"
                className="group relative flex size-32 flex-col items-center justify-center gap-1.5 rounded-full bg-accent-primary text-bg-primary shadow-[0_18px_50px_-20px_var(--brand-accent-primary)] transition hover:brightness-105 active:scale-[0.98] sm:size-40"
              >
                <Mic className="size-7 sm:size-9" />
                <span className="text-[13px] font-semibold sm:text-[15px]">New recording</span>
                <span className="text-[10.5px] font-medium text-bg-primary/70">⌘ N</span>
              </button>
            </div>
          </div>
        </section>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,1fr)]">
          <section
            aria-labelledby="continue-heading"
            className="panel flex flex-col overflow-hidden"
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-3.5">
              <h2
                id="continue-heading"
                className="flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.12em] text-text-muted"
              >
                <History className="size-3.5" />
                Pick up where you left off
              </h2>
              <span className="text-[12px] text-text-muted">{latest.dateLabel}</span>
            </header>
            <div className="flex flex-1 flex-col p-5 sm:p-6">
              <h3 className="text-[21px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
                {latest.title}
              </h3>
              <p className="mt-1 text-[13.5px] font-medium text-accent-primary">
                {latest.summary.headline}
              </p>
              <p className="mt-3 line-clamp-3 text-[13.5px] leading-6 text-text-muted">
                {latest.summary.paragraphs[0]?.text}
              </p>
              <p className="mt-2 line-clamp-3 text-[13px] leading-5 text-text-muted">
                {latest.summary.paragraphs[1]?.text}
              </p>
              <div className="mt-4 grid gap-2 rounded-brand border border-border-subtle/70 bg-bg-primary/25 p-3.5 sm:grid-cols-2">
                {latest.summary.keyPoints.slice(0, 4).map((point) => (
                  <div
                    key={point}
                    className="flex items-start gap-2 text-[12.5px] leading-5 text-text-muted"
                  >
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-accent-primary" />
                    <span>{point}</span>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-text-muted">
                <span className="flex items-center gap-2">
                  <AvatarStack people={latest.participants} size="xs" />
                  {latest.participants.length} people
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock3 className="size-3.5" />
                  {formatDuration(latest.durationMs)}
                </span>
                {latestPending > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <ListChecks className="size-3.5" />
                    {latestPending} open {latestPending === 1 ? "step" : "steps"}
                  </span>
                ) : null}
              </div>
              <div className="mt-auto flex flex-wrap gap-2 pt-5">
                <Link
                  href={`/meeting/${latest.id}/`}
                  className={buttonClass({ variant: "primary", size: "md" })}
                >
                  Continue reading
                  <ArrowRight className="size-3.5" />
                </Link>
                <Link
                  href={`/meeting/${latest.id}/synthesis/`}
                  className={buttonClass({ variant: "secondary", size: "md" })}
                >
                  View summary
                </Link>
              </div>
            </div>
          </section>

          <section
            id="next-steps"
            aria-labelledby="next-steps-heading"
            className="panel flex scroll-mt-8 flex-col overflow-hidden"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3.5">
              <div>
                <h2
                  id="next-steps-heading"
                  className="text-[17px] font-semibold tracking-[-0.015em] text-text-primary"
                >
                  Next steps
                </h2>
                <p className="mt-0.5 text-[12px] text-text-muted">
                  Open items from your recent meetings.
                </p>
              </div>
              <Pill tone="warning" className="shrink-0 text-[11px]">
                {PENDING_ACTIONS.length} open
              </Pill>
            </header>
            <ul className="divide-y divide-border-subtle/70">
              {visibleSteps.map(({ meeting, action, owner }) => (
                <li key={`${meeting.id}-${action.id}`}>
                  <Link
                    href={`/meeting/${meeting.id}/synthesis/`}
                    className="group flex items-start gap-3 px-5 py-3.5 transition hover:bg-bg-elevated/40"
                  >
                    <span className="mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-full border border-border-subtle transition group-hover:border-accent-primary/50">
                      <span className="size-1.5 rounded-full bg-border-subtle transition group-hover:bg-accent-primary/70" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-5 text-text-primary">
                        {action.task}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-muted">
                        {owner ? (
                          <span className="flex items-center gap-1.5">
                            <Avatar
                              name={owner.name}
                              tone={owner.tone}
                              size="xs"
                              className="size-4 text-[7px]"
                            />
                            {owner.name}
                          </span>
                        ) : (
                          <span>Unassigned</span>
                        )}
                        <span className="text-border-subtle">·</span>
                        <span>{action.deadline ?? "Not specified"}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-text-muted/70">
                        {meeting.title}
                      </span>
                    </span>
                    <ChevronRight className="mt-1 size-3.5 shrink-0 text-text-muted/30 transition group-hover:translate-x-0.5 group-hover:text-text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setShowAllSteps((value) => !value)}
              className="mt-auto flex items-center justify-center gap-1.5 border-t border-border-subtle px-5 py-3 text-[12px] font-medium text-text-muted transition hover:bg-bg-elevated/40 hover:text-text-primary"
            >
              {showAllSteps ? (
                <>
                  Show fewer
                  <ChevronUp className="size-3.5" />
                </>
              ) : (
                <>
                  See all {PENDING_ACTIONS.length} next steps
                  <ChevronDown className="size-3.5" />
                </>
              )}
            </button>
          </section>
        </div>

        <section
          id="recent"
          aria-labelledby="recent-heading"
          className="panel mt-5 scroll-mt-8 overflow-hidden"
        >
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
            <div>
              <h2
                id="recent-heading"
                className="text-[17px] font-semibold tracking-[-0.015em] text-text-primary"
              >
                Recent conversations
              </h2>
              <p className="mt-0.5 text-[12px] text-text-muted">Catch up on anything you missed.</p>
            </div>
            <button
              type="button"
              onClick={openPalette}
              className="flex h-8 items-center gap-1.5 rounded-brand px-2.5 text-[12px] font-medium text-text-muted transition hover:bg-bg-elevated/60 hover:text-text-primary"
            >
              <Search className="size-3.5" />
              Search all
            </button>
          </header>
          {MEETINGS.map((meeting) => (
            <MeetingRow key={meeting.id} meeting={meeting} />
          ))}
        </section>

        <LocalRecordings />

        <footer className="mt-8 flex flex-col items-start justify-between gap-2 border-t border-border-subtle pt-5 text-[12px] text-text-muted sm:flex-row sm:items-center">
          <p className="flex items-center gap-2">
            <ShieldCheck className="size-3.5 text-accent-primary" />
            Your recordings stay on this Mac. Nothing is uploaded.
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
