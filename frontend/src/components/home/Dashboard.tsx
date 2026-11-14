"use client";

import Link from "next/link";
import {
  ArrowRight,
  AudioLines,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Cpu,
  Database,
  FolderOpen,
  HardDrive,
  ListChecks,
  LockKeyhole,
  Mic,
  MonitorUp,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  Users,
} from "lucide-react";

import { AppShell } from "@/components/shell/AppShell";
import { Avatar, AvatarStack } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { MiniWaveform } from "@/components/ui/Waveform";
import { Pill } from "@/components/ui/Pill";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { BRAND } from "@/generated/brand";
import {
  DEMO_HARDWARE,
  DEMO_INDEX,
  DEMO_MODEL_FOOTPRINT,
  MEETINGS,
  PENDING_ACTIONS,
  VAULT_STATS,
  meetingActionOwner,
  type Meeting,
} from "@/lib/demo-data";
import { formatBytes, formatDuration } from "@/lib/format";
import { openHud } from "@/lib/hud";
import { useWorkspaceStore } from "@/stores/workspace";

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  accent,
  children,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Mic;
  accent?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="panel group relative overflow-hidden p-4 transition-colors hover:border-text-muted/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            {label}
          </p>
          <p className="mt-1.5 text-[24px] font-medium leading-none tracking-[-0.035em] text-text-primary">
            {value}
          </p>
        </div>
        <span
          className={
            accent
              ? "flex size-7 items-center justify-center rounded-[7px] border border-accent-primary/20 bg-accent-primary/10 text-accent-primary"
              : "flex size-7 items-center justify-center rounded-[7px] border border-border-subtle bg-bg-primary/40 text-text-muted"
          }
        >
          <Icon className="size-3.5" />
        </span>
      </div>
      {children}
      <p className="mt-2.5 text-[10px] leading-4 text-text-muted">{detail}</p>
    </div>
  );
}

function MeetingRow({ meeting, index }: { meeting: Meeting; index: number }) {
  const pending = meeting.actions.filter((action) => !action.done).length;
  const screenshots = meeting.screenshots.length;

  return (
    <Link
      href={`/meeting/${meeting.id}/`}
      className="group relative block border-b border-border-subtle/80 px-4 py-3.5 transition-colors last:border-b-0 hover:bg-bg-elevated/50"
    >
      <div className="flex gap-3">
        <div className="pt-0.5">
          <span className="flex size-8 items-center justify-center rounded-[7px] border border-border-subtle bg-bg-primary/50 text-text-muted">
            <AudioLines className="size-3.5" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-[13px] font-medium tracking-[-0.01em] text-text-primary">
              {meeting.title}
            </h3>
            {index === 0 && (
              <Pill tone="accent" className="gap-1">
                <span className="size-1 rounded-full bg-accent-primary" />
                Latest
              </Pill>
            )}
            {pending > 0 && <Pill tone="warning">{pending} pending</Pill>}
          </div>
          <p className="mt-0.5 truncate text-[11px] leading-5 text-text-muted">
            {meeting.summary.headline} · {meeting.notes.length} note lines
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[9.5px] text-text-muted">
            <span className="flex items-center gap-1">
              <Clock3 className="size-2.5" /> {formatDuration(meeting.durationMs)}
            </span>
            <span className="flex items-center gap-1">
              <Camera className="size-2.5" /> {screenshots}
            </span>
            <span className="flex items-center gap-1">
              <ListChecks className="size-2.5" /> {meeting.actions.length}
            </span>
            <span className="flex items-center gap-1 truncate">
              <FolderOpen className="size-2.5" /> {meeting.folder}
            </span>
          </div>
        </div>
        <div className="hidden w-28 shrink-0 flex-col items-end justify-between gap-1 sm:flex">
          <span className="tabular text-[9px] text-text-muted/80">{meeting.dateLabel}</span>
          <MiniWaveform
            seed={index + 3}
            bars={26}
            tone={index === 0 ? "accent" : index === 1 ? "secondary" : "muted"}
            className="h-5 opacity-70 transition group-hover:opacity-100"
          />
          <AvatarStack people={meeting.participants} size="xs" max={3} />
        </div>
        <ChevronRight className="mt-1 size-3.5 shrink-0 text-text-muted/40 transition group-hover:translate-x-0.5 group-hover:text-text-muted" />
      </div>
    </Link>
  );
}

export function Dashboard() {
  const openPalette = useWorkspaceStore((state) => state.openPalette);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const recentPending = PENDING_ACTIONS.slice(0, 5);

  return (
    <AppShell>
      <div className="sticky top-0 z-20 border-b border-border-subtle bg-bg-primary/85 backdrop-blur-md">
        <div className="mx-auto flex h-12 max-w-[1440px] items-center gap-3 px-5 lg:px-7">
          <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-text-muted">
            <Database className="size-3 text-text-muted/70" />
            <span>Local vault</span>
            <ChevronRight className="size-2.5 text-text-muted/40" />
            <span className="text-text-primary">Overview</span>
          </div>
          <Pill
            tone="accent"
            className="ml-1 hidden gap-1 sm:inline-flex"
            icon={<ShieldCheck className="size-2.5" />}
          >
            Offline enforced
          </Pill>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-[9.5px] text-text-muted sm:inline">
              Fri, Nov 14 · 4:12 PM
            </span>
            <button
              type="button"
              onClick={openPalette}
              aria-label="Open command palette"
              className="flex h-7 items-center gap-2 rounded-brand border border-border-subtle bg-bg-primary/35 px-2.5 text-[10px] text-text-muted transition hover:border-text-muted/30 hover:text-text-primary"
            >
              <Search className="size-3" />
              <span className="hidden sm:inline">Search vault</span>
              <Kbd>⌘K</Kbd>
            </button>
            <Avatar name="You" tone="violet" size="sm" />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1440px] px-5 pb-16 pt-5 lg:px-7">
        <section className="relative overflow-hidden rounded-[12px] border border-border-subtle bg-[radial-gradient(110%_130%_at_0%_0%,color-mix(in_oklch,var(--brand-accent-primary)_10%,transparent),transparent_55%)] p-5 lg:p-6">
          <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[42%] items-center justify-center overflow-hidden md:flex">
            <div
              aria-hidden="true"
              className="absolute inset-0 opacity-[0.22]"
              style={{
                backgroundImage:
                  "linear-gradient(to right, var(--brand-border-subtle) 1px, transparent 1px), linear-gradient(to bottom, var(--brand-border-subtle) 1px, transparent 1px)",
                backgroundSize: "28px 28px",
                maskImage: "radial-gradient(ellipse at center, black, transparent 78%)",
              }}
            />
            <div className="relative flex items-center gap-3 rounded-brand border border-border-subtle bg-bg-primary/55 px-4 py-3 backdrop-blur-sm">
              <span className="relative flex size-9 items-center justify-center rounded-full border border-recording-pulse/25 bg-recording-pulse/[0.07]">
                <span className="size-2 rounded-full bg-recording-pulse" />
                <span className="absolute inset-0 animate-ping rounded-full border border-recording-pulse/20" />
              </span>
              <div>
                <p className="text-[11px] font-medium text-text-primary">Recorder ready</p>
                <p className="mt-0.5 text-[9.5px] text-text-muted">
                  CoreAudio · ScreenCaptureKit · 2 channels
                </p>
              </div>
              <MiniWaveform seed={12} bars={24} playing className="ml-2 h-5 w-16 opacity-80" />
            </div>
          </div>

          <div className="relative max-w-[660px]">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="neutral" className="gap-1.5">
                <span className="size-1 rounded-full bg-accent-primary" />
                {BRAND.productName} · local vault
              </Pill>
              <Pill tone="outline">SQLite · WAL</Pill>
              <Pill tone="outline" icon={<LockKeyhole className="size-2.5" />}>
                No egress
              </Pill>
            </div>
            <h1 className="mt-4 text-[27px] font-semibold leading-[1.1] tracking-[-0.04em] text-text-primary sm:text-[31px]">
              Everything stays here.
            </h1>
            <p className="mt-2 max-w-[510px] text-[12px] leading-6 text-text-muted">
              {VAULT_STATS.memoCount} memos and {VAULT_STATS.capturedHours} hours of conversation
              are indexed on this machine. Record the next room, attach the slides, and let the
              local verifier hold every claim to its evidence.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="md"
                leading={<Mic className="size-3.5" />}
                trailing={
                  <Kbd className="border-bg-primary/20 bg-bg-primary/15 text-bg-primary">⌘N</Kbd>
                }
                onClick={openNewRecording}
              >
                New recording
              </Button>
              <Button
                variant="secondary"
                size="md"
                leading={<MonitorUp className="size-3.5" />}
                onClick={() => void openHud()}
              >
                Open HUD
              </Button>
              <span className="ml-1 hidden items-center gap-1.5 text-[10px] text-text-muted sm:flex">
                <CheckCircle2 className="size-3 text-accent-primary" />5 local artifacts ·{" "}
                {DEMO_MODEL_FOOTPRINT}
              </span>
            </div>
          </div>
        </section>

        <section
          className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
          aria-label="Vault statistics"
        >
          <StatCard
            label="Memos"
            value={String(VAULT_STATS.memoCount)}
            detail="3 shown below · all indexed with FTS5"
            icon={AudioLines}
            accent
          >
            <div className="mt-3 flex items-end justify-between">
              <MiniWaveform seed={2} bars={24} className="h-4 w-24 opacity-70" />
              <span className="text-[9px] text-accent-primary">+4 this week</span>
            </div>
          </StatCard>
          <StatCard
            label="Captured"
            value={`${VAULT_STATS.capturedHours}h`}
            detail="Dual-channel audio · 2,464 transcript segments"
            icon={Clock3}
          >
            <div className="mt-3 flex items-center gap-1.5">
              <span className="h-1 flex-1 rounded-full bg-accent-primary/60" />
              <span className="h-1 flex-[2] rounded-full bg-accent-secondary/50" />
              <span className="h-1 flex-[1.4] rounded-full bg-violet-500/50" />
              <span className="h-1 flex-1 rounded-full bg-border-subtle" />
            </div>
          </StatCard>
          <StatCard
            label="Pending actions"
            value={String(VAULT_STATS.pendingActions)}
            detail="2 unassigned · 1 missing deadline"
            icon={ListChecks}
          >
            <div className="mt-3 flex items-center gap-1.5">
              {Array.from({ length: 8 }).map((_, index) => (
                <span
                  key={index}
                  className={
                    index < 5
                      ? "h-1 flex-1 rounded-full bg-amber-500/70"
                      : "h-1 flex-1 rounded-full bg-border-subtle"
                  }
                />
              ))}
            </div>
          </StatCard>
          <StatCard
            label="Vault storage"
            value={formatBytes(VAULT_STATS.storageBytes)}
            detail={`${VAULT_STATS.screenshots} screenshots · local WebP assets`}
            icon={HardDrive}
          >
            <div className="mt-3">
              <ProgressBar value={36} label="Vault storage used" size="sm" />
              <div className="mt-1 flex justify-between text-[8.5px] text-text-muted">
                <span>audio · notes · slides</span>
                <span>36% of 5 GB</span>
              </div>
            </div>
          </StatCard>
        </section>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            <section id="recent" aria-labelledby="recent-heading" className="panel overflow-hidden">
              <header className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
                <div>
                  <h2 id="recent-heading" className="text-[12px] font-semibold text-text-primary">
                    Recent memos
                  </h2>
                  <p className="mt-0.5 text-[9.5px] text-text-muted">
                    3 of {VAULT_STATS.memoCount} · sorted by local activity
                  </p>
                </div>
                <button
                  type="button"
                  onClick={openPalette}
                  className="flex items-center gap-1 rounded-brand px-2 py-1 text-[10px] text-text-muted transition hover:bg-bg-primary/50 hover:text-text-primary"
                >
                  Search all
                  <ArrowRight className="size-3" />
                </button>
              </header>
              {MEETINGS.map((meeting, index) => (
                <MeetingRow key={meeting.id} meeting={meeting} index={index} />
              ))}
            </section>

            <section
              aria-labelledby="capture-heading"
              className="relative overflow-hidden rounded-brand border border-dashed border-border-subtle bg-bg-primary/25 p-4"
            >
              <div className="flex flex-wrap items-center gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-accent-primary/20 bg-accent-primary/[0.07] text-accent-primary">
                  <Mic className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id="capture-heading" className="text-[12px] font-medium text-text-primary">
                      Nothing is recording
                    </h2>
                    <Pill tone="outline">Room ready</Pill>
                  </div>
                  <p className="mt-1 max-w-[560px] text-[10.5px] leading-5 text-text-muted">
                    Start a session and the HUD detaches into a 320×48 always-on-top pill. Notes,
                    transcript deltas, and screenshots stream into the vault as you talk.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    leading={<Camera className="size-3" />}
                    onClick={() => void openHud()}
                  >
                    HUD
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    leading={<Mic className="size-3" />}
                    onClick={openNewRecording}
                  >
                    Record
                  </Button>
                </div>
              </div>
              <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-40 items-center justify-end pr-5 opacity-30 lg:flex">
                <MiniWaveform seed={22} bars={26} tone="muted" />
              </div>
            </section>
          </div>

          <aside className="min-w-0 space-y-4">
            <section
              id="pending-actions"
              aria-labelledby="pending-heading"
              className="panel overflow-hidden scroll-mt-16"
            >
              <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <div>
                  <h2
                    id="pending-heading"
                    className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                  >
                    <ListChecks className="size-3.5 text-amber-600 dark:text-amber-300" />
                    Action items
                  </h2>
                  <p className="mt-0.5 text-[9.5px] text-text-muted">
                    {PENDING_ACTIONS.length} pending · verified evidence only
                  </p>
                </div>
                <Pill tone="warning">{PENDING_ACTIONS.length}</Pill>
              </header>
              <div className="divide-y divide-border-subtle/70">
                {recentPending.map(({ meeting, action, owner }) => (
                  <Link
                    key={`${meeting.id}-${action.id}`}
                    href={`/meeting/${meeting.id}/synthesis/`}
                    className="group block px-4 py-2.5 transition hover:bg-bg-elevated/50"
                  >
                    <div className="flex items-start gap-2">
                      <span className="mt-1 size-2 shrink-0 rounded-[2px] border border-border-subtle" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[10.5px] font-medium leading-4 text-text-primary">
                          {action.task}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {owner ? (
                            <Pill tone="neutral" className="gap-1">
                              <Avatar
                                name={owner.name}
                                tone={owner.tone}
                                size="xs"
                                className="size-3 text-[6px]"
                              />
                              {owner.name}
                            </Pill>
                          ) : (
                            <Pill tone="outline">Unassigned</Pill>
                          )}
                          <Pill tone={action.deadline ? "neutral" : "outline"}>
                            {action.deadline ?? "Not specified"}
                          </Pill>
                        </div>
                        <p className="mt-1 truncate text-[8.5px] text-text-muted/70">
                          {meeting.title}
                        </p>
                      </div>
                      <ChevronRight className="mt-1 size-3 shrink-0 text-text-muted/30 group-hover:text-text-muted" />
                    </div>
                  </Link>
                ))}
              </div>
              <Link
                href="/meeting/demo-q3-launch/synthesis/"
                className="flex items-center justify-between border-t border-border-subtle px-4 py-2 text-[9.5px] text-text-muted transition hover:bg-bg-elevated/50 hover:text-text-primary"
              >
                <span>Open synthesis canvas</span>
                <ArrowRight className="size-3" />
              </Link>
            </section>

            <section
              id="speakers"
              aria-labelledby="speakers-heading"
              className="panel scroll-mt-16 p-4"
            >
              <div className="flex items-center justify-between">
                <h2
                  id="speakers-heading"
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                >
                  <Users className="size-3.5 text-text-muted" />
                  By speaker
                </h2>
                <span className="tabular text-[9px] text-text-muted">
                  {VAULT_STATS.speakers} enrolled
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {[
                  {
                    name: "Sarah Chen",
                    role: "Head of Product",
                    tone: "accent" as const,
                    count: 14,
                  },
                  {
                    name: "Alex Rivera",
                    role: "Engineering Lead",
                    tone: "secondary" as const,
                    count: 11,
                  },
                  { name: "You", role: "Product", tone: "violet" as const, count: 17 },
                ].map((speaker) => (
                  <div key={speaker.name} className="flex items-center gap-2.5">
                    <Avatar name={speaker.name} tone={speaker.tone} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[10.5px] font-medium text-text-primary">
                        {speaker.name}
                      </p>
                      <p className="truncate text-[8.5px] text-text-muted">{speaker.role}</p>
                    </div>
                    <div className="h-1 w-14 overflow-hidden rounded-full bg-border-subtle">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, speaker.count * 5)}%`,
                          backgroundColor:
                            speaker.tone === "accent"
                              ? "var(--brand-accent-primary)"
                              : speaker.tone === "secondary"
                                ? "var(--brand-accent-secondary)"
                                : "oklch(0.66 0.14 300)",
                        }}
                      />
                    </div>
                    <span className="tabular w-5 text-right text-[9px] text-text-muted">
                      {speaker.count}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section
              id="folders"
              aria-labelledby="folders-heading"
              className="panel scroll-mt-16 p-4"
            >
              <div className="flex items-center justify-between">
                <h2
                  id="folders-heading"
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                >
                  <FolderOpen className="size-3.5 text-text-muted" />
                  Folders
                </h2>
                <span className="tabular text-[9px] text-text-muted">{VAULT_STATS.folders}</span>
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                {[
                  { name: "Launch", count: 8 },
                  { name: "Architecture", count: 5 },
                  { name: "Design", count: 6 },
                  { name: "Customers", count: 3 },
                ].map((folder) => (
                  <div
                    key={folder.name}
                    className="flex items-center justify-between rounded-[6px] border border-border-subtle bg-bg-primary/30 px-2 py-1.5 text-[9.5px] text-text-muted"
                  >
                    <span className="truncate">{folder.name}</span>
                    <span className="tabular text-[8px] text-text-muted/60">{folder.count}</span>
                  </div>
                ))}
              </div>
              <div id="tags" className="mt-3 scroll-mt-16 border-t border-border-subtle pt-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[9px] text-text-muted">
                  <Tag className="size-2.5" />
                  Tags
                </div>
                <div className="flex flex-wrap gap-1">
                  {[
                    "Q3",
                    "launch",
                    "billing",
                    "ADR-014",
                    "onboarding",
                    "consent",
                    "reliability",
                  ].map((tag) => (
                    <Pill key={tag} tone="outline">
                      {tag}
                    </Pill>
                  ))}
                  <Pill tone="outline">+2</Pill>
                </div>
              </div>
            </section>

            <section aria-labelledby="health-heading" className="panel p-4">
              <div className="flex items-center justify-between">
                <h2
                  id="health-heading"
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                >
                  <ShieldCheck className="size-3.5 text-accent-primary" />
                  Vault health
                </h2>
                <Pill tone="accent">All local</Pill>
              </div>
              <dl className="mt-3 space-y-2 text-[9.5px]">
                {[
                  ["Index", `${DEMO_INDEX.engine} · ${DEMO_INDEX.indexedRows} rows`],
                  ["Journal", `${DEMO_INDEX.journal} · ok`],
                  ["Egress", "0 bytes since install"],
                  ["Acceleration", `${DEMO_HARDWARE.accelerators.join(" · ")}`],
                  ["Pinned models", `${DEMO_MODEL_FOOTPRINT} · 5 artifacts`],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-start justify-between gap-3">
                    <dt className="text-text-muted">{label}</dt>
                    <dd className="text-right font-mono text-[8.5px] leading-4 text-text-primary/80">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 flex items-center gap-1.5 rounded-[6px] border border-accent-primary/15 bg-accent-primary/[0.05] px-2 py-1.5 text-[8.5px] text-text-muted">
                <Cpu className="size-2.5 text-accent-primary" />
                {DEMO_HARDWARE.host} · {DEMO_HARDWARE.tier} tier
              </div>
            </section>
          </aside>
        </div>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-4 text-[9px] text-text-muted/70">
          <span>
            {BRAND.productName} · {BRAND.licenseType} · brand id {BRAND.brandId}
          </span>
          <span className="flex items-center gap-1.5">
            <Sparkles className="size-2.5 text-accent-primary" />
            Local synthesis verified 12/12 claims · source-linked
          </span>
        </footer>
      </div>
    </AppShell>
  );
}
