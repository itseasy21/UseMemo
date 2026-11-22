"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  FileDown,
  Loader2,
  MonitorUp,
  NotebookPen,
  PencilLine,
  Sparkles,
  Star,
} from "lucide-react";

import { AvatarStack } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { BRAND } from "@/generated/brand";
import { meetingHref, synthesisHref, type Meeting } from "@/lib/demo-data";
import { formatDuration } from "@/lib/format";
import { exportMeeting, setMeetingStarred, updateMeeting } from "@/lib/host";
import { openHud } from "@/lib/hud";
import { isImeComposing } from "@/lib/ime";
import { hasMacOverlayTrafficLights } from "@/lib/platform";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

export function StudioHeader({
  meeting,
  mode,
  onMutate,
}: {
  meeting: Meeting;
  mode: "studio" | "synthesis";
  onMutate?: (updater: (current: Meeting) => Meeting) => void;
}) {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const [macOverlay, setMacOverlay] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(meeting.title);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setMacOverlay(hasMacOverlayTrafficLights());
  }, []);

  useEffect(() => {
    setTitleDraft(meeting.title);
  }, [meeting.title]);

  const commitTitle = async () => {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (!trimmed || trimmed === meeting.title) {
      setTitleDraft(meeting.title);
      return;
    }
    onMutate?.((curr) => ({ ...curr, title: trimmed }));
    if (isTauri() && !meeting.isDemo) {
      try {
        await updateMeeting(meeting.id, { title: trimmed });
        pushToast("Renamed memo", trimmed, "success");
      } catch (error) {
        onMutate?.((curr) => ({ ...curr, title: meeting.title }));
        pushToast("Could not rename memo", formatHostError(error), "danger");
      }
    }
  };

  const toggleStar = async () => {
    const next = !meeting.isStarred;
    onMutate?.((curr) => ({ ...curr, isStarred: next }));
    if (isTauri() && !meeting.isDemo) {
      try {
        await setMeetingStarred(meeting.id, next);
      } catch (error) {
        onMutate?.((curr) => ({ ...curr, isStarred: !next }));
        pushToast("Could not update star", formatHostError(error), "danger");
      }
    }
  };

  const handleExport = async () => {
    if (exporting) return;
    if (!isTauri() || meeting.isDemo) {
      pushToast(
        "Export ready",
        "Markdown bundle export writes to the vault inside the desktop app.",
        "accent",
      );
      return;
    }
    setExporting(true);
    try {
      const outcome = await exportMeeting(meeting.id);
      if (outcome) {
        pushToast(
          "Exported Markdown bundle",
          `${outcome.markdownPath} (${outcome.copiedImages} slide assets)`,
          "success",
        );
      }
    } catch (error) {
      pushToast("Export failed", formatHostError(error), "danger");
    } finally {
      setExporting(false);
    }
  };

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-16 shrink-0 items-center gap-3 border-b border-[var(--glass-border)] bg-[var(--shell-sidebar)] px-4 sm:px-5",
        macOverlay && "pl-[80px] sm:pl-[86px]",
      )}
    >
      <Link
        href="/"
        aria-label={`Back to ${BRAND.productName} meetings`}
        className="flex h-9 items-center gap-1.5 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] px-3 text-xs font-medium text-text-muted transition hover:text-text-primary"
      >
        <ChevronLeft className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Meetings</span>
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {editingTitle ? (
          <input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (isImeComposing(event)) return;
                void commitTitle();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setTitleDraft(meeting.title);
                setEditingTitle(false);
              }
            }}
            aria-label="Meeting title"
            autoFocus
            className="glass-input h-8 w-[220px] max-w-[48vw] px-2.5 text-[14px] font-semibold text-text-primary outline-none sm:w-[300px]"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingTitle(true)}
            title="Click to rename"
            className="group flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left transition hover:bg-[var(--glass-surface-subtle)]"
          >
            <h1 className="max-w-[38vw] truncate text-[15px] font-semibold tracking-[-0.015em] text-text-primary sm:max-w-[320px]">
              {meeting.title}
            </h1>
            <PencilLine
              aria-hidden="true"
              className="size-3.5 shrink-0 text-text-muted opacity-0 transition group-hover:opacity-100"
            />
          </button>
        )}

        <button
          type="button"
          onClick={() => void toggleStar()}
          aria-label={meeting.isStarred ? "Unstar memo" : "Star memo"}
          aria-pressed={Boolean(meeting.isStarred)}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg transition",
            meeting.isStarred
              ? "text-amber-400"
              : "text-text-muted/55 hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary",
          )}
        >
          <Star
            aria-hidden="true"
            className={cn("size-3.5", meeting.isStarred && "fill-current")}
          />
        </button>

        <span className="tabular hidden shrink-0 text-xs text-text-muted lg:inline">
          {meeting.dateLabel} · {formatDuration(meeting.durationMs)}
        </span>

        {meeting.status === "recording" && (
          <Pill
            tone="danger"
            icon={<span className="size-1.5 animate-pulse rounded-full bg-recording-pulse" />}
          >
            Live
          </Pill>
        )}
      </div>

      {/* Segmented Studio / AI Summary Switcher */}
      <nav
        aria-label="Meeting view mode"
        className="flex h-10 items-center rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] p-1"
      >
        <Link
          href={meetingHref(meeting.id)}
          aria-current={mode === "studio" ? "page" : undefined}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition",
            mode === "studio"
              ? "bg-accent-primary text-bg-primary shadow-xs"
              : "text-text-muted hover:text-text-primary",
          )}
        >
          <NotebookPen className="size-3.5" aria-hidden="true" />
          <span>Studio</span>
        </Link>
        <Link
          href={synthesisHref(meeting.id)}
          aria-current={mode === "synthesis" ? "page" : undefined}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition",
            mode === "synthesis"
              ? "bg-accent-primary text-bg-primary shadow-xs"
              : "text-text-muted hover:text-text-primary",
          )}
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          <span>AI Summary</span>
        </Link>
      </nav>

      <div className="flex shrink-0 items-center gap-1.5">
        <div className="hidden xl:block">
          <AvatarStack people={meeting.participants} size="sm" max={3} />
        </div>
        <button
          type="button"
          onClick={() => void openHud()}
          title="Open floating mini recorder"
          className="glass-subtle hidden h-8 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium text-text-muted transition hover:text-text-primary md:inline-flex"
        >
          <MonitorUp className="size-3.5" aria-hidden="true" />
          HUD
        </button>
        <Button
          variant="secondary"
          size="sm"
          className="hidden md:inline-flex"
          leading={
            exporting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileDown className="size-3.5" />
            )
          }
          disabled={exporting}
          onClick={() => void handleExport()}
        >
          Export
        </Button>
      </div>
    </header>
  );
}
