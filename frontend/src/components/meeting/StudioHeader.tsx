"use client";

import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  ListChecks,
  MonitorUp,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { AvatarStack } from "@/components/ui/Avatar";
import { BrandMark } from "@/components/ui/Brand";
import { buttonClass } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { BRAND } from "@/generated/brand";
import type { Meeting } from "@/lib/demo-data";
import { formatDuration } from "@/lib/format";
import { openHud } from "@/lib/hud";
import { cn } from "@/lib/utils";

export function StudioHeader({
  meeting,
  mode,
}: {
  meeting: Meeting;
  mode: "studio" | "synthesis";
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border-subtle bg-bg-primary/90 px-3 backdrop-blur-md sm:px-4">
      <Link
        href="/"
        aria-label={`Back to ${BRAND.productName} vault`}
        className="flex items-center gap-1.5 rounded-brand px-1 py-1 text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
      >
        <ChevronLeft className="size-3.5" />
        <BrandMark className="size-6" />
      </Link>
      <span className="hidden h-5 w-px bg-border-subtle sm:block" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 text-[9px] text-text-muted">
          <Link href="/" className="hidden hover:text-text-primary sm:inline">
            Vault
          </Link>
          <ChevronRight className="hidden size-2.5 text-text-muted/40 sm:inline" />
          <Link
            href={`/meeting/${meeting.id}/`}
            className="hidden max-w-[180px] truncate hover:text-text-primary sm:inline"
          >
            {meeting.title}
          </Link>
          <ChevronRight className="hidden size-2.5 text-text-muted/40 sm:inline" />
          <span className="text-text-primary">{mode === "studio" ? "Studio" : "Synthesis"}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="max-w-[46vw] truncate text-[13px] font-semibold tracking-[-0.015em] text-text-primary sm:max-w-[340px]">
            {meeting.title}
          </h1>
          <span className="tabular hidden shrink-0 text-[9px] text-text-muted md:inline">
            {meeting.dateLabel} · {formatDuration(meeting.durationMs)}
          </span>
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <span className="hidden items-center gap-1.5 rounded-full border border-border-subtle bg-bg-primary/40 px-2 py-1 text-[9px] text-text-muted lg:flex">
          <ShieldCheck className="size-2.5 text-accent-primary" />
          Saved locally
        </span>
        <div className="hidden xl:block">
          <AvatarStack people={meeting.participants} size="sm" max={3} />
        </div>
        <span className="hidden h-5 w-px bg-border-subtle lg:block" />
        <button
          type="button"
          onClick={() => void openHud()}
          className="hidden items-center gap-1.5 rounded-brand px-2 py-1.5 text-[10px] text-text-muted transition hover:bg-bg-elevated hover:text-text-primary md:flex"
        >
          <MonitorUp className="size-3" />
          HUD
        </button>
        <Link
          href={mode === "studio" ? `/meeting/${meeting.id}/synthesis/` : `/meeting/${meeting.id}/`}
          className={buttonClass({
            variant: mode === "studio" ? "secondary" : "primary",
            size: "sm",
            className: "gap-1.5",
          })}
        >
          {mode === "studio" ? (
            <>
              <Sparkles className="size-3" />
              Synthesis
            </>
          ) : (
            <>
              <ListChecks className="size-3" />
              Open studio
            </>
          )}
        </Link>
        <Pill
          tone="accent"
          className={cn("hidden gap-1 xl:inline-flex", mode === "synthesis" && "xl:hidden")}
          icon={<span className="size-1 rounded-full bg-accent-primary" />}
        >
          {mode === "studio" ? "Capture" : "Verified"}
        </Pill>
      </div>
    </header>
  );
}
