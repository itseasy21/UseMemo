"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  FileDown,
  Loader2,
  Menu,
  Mic,
  MonitorUp,
  PanelRightClose,
  PanelRightOpen,
  Search,
  SunMoon,
} from "lucide-react";

import { BrandMark } from "@/components/ui/Brand";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { BRAND } from "@/generated/brand";
import type { Meeting } from "@/lib/demo-data";
import { exportMeeting } from "@/lib/host";
import { openHud } from "@/lib/hud";
import { hasMacOverlayTrafficLights, modKeyPrefix } from "@/lib/platform";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

export function TopHeaderBar({
  meeting,
  drawerId,
  showRightToggle = true,
}: {
  meeting?: Meeting;
  drawerId?: string;
  showRightToggle?: boolean;
}) {
  const router = useRouter();
  const [macOverlay, setMacOverlay] = useState(false);
  const [modKey, setModKey] = useState("⌘");
  const [exporting, setExporting] = useState(false);

  const sidebarCollapsed = useWorkspaceStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const mobileNavOpen = useWorkspaceStore((state) => state.mobileNavOpen);
  const openMobileNav = useWorkspaceStore((state) => state.openMobileNav);
  const openPalette = useWorkspaceStore((state) => state.openPalette);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const rightPanelOpen = useWorkspaceStore((state) => state.rightPanelOpen);
  const toggleRightPanel = useWorkspaceStore((state) => state.toggleRightPanel);
  const theme = useWorkspaceStore((state) => state.theme);
  const toggleTheme = useWorkspaceStore((state) => state.toggleTheme);
  const pushToast = useWorkspaceStore((state) => state.pushToast);

  useEffect(() => {
    setMacOverlay(hasMacOverlayTrafficLights());
    setModKey(modKeyPrefix());
  }, []);

  const handleExport = async () => {
    if (!meeting || exporting) return;
    if (!isTauri() || meeting.isDemo) {
      pushToast(
        "Export ready",
        "Markdown bundle export writes to the local vault inside the desktop app.",
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

  const handleCopySummary = async () => {
    if (!meeting) return;
    const lines: string[] = [
      `# ${meeting.title}`,
      `${meeting.dateLabel}`,
      "",
      "## Overview",
      meeting.summary.headline,
      "",
      ...meeting.summary.paragraphs.map((p) => `- ${p.text}`),
    ];
    if (meeting.decisions.length > 0) {
      lines.push("", "## Decisions", ...meeting.decisions.map((d) => `- ${d.text}`));
    }
    if (meeting.actions.length > 0) {
      lines.push(
        "",
        "## Action Items",
        ...meeting.actions.map((a) => `- [${a.done ? "x" : " "}] ${a.task}`),
      );
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast("Summary copied", "Formatted Markdown summary copied to clipboard.", "success");
    } catch {
      pushToast("Could not copy", "Clipboard access was denied.", "danger");
    }
  };

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "relative z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--glass-border)] bg-[var(--glass-surface)] px-3.5 backdrop-blur-2xl",
        macOverlay && "pl-[82px]",
      )}
    >
      {/* Left: Brand + Sidebar Collapse + Back/Forward Arrows */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={openMobileNav}
          aria-label="Open navigation menu"
          aria-expanded={mobileNavOpen}
          aria-controls={drawerId}
          className="flex size-8 items-center justify-center rounded-xl text-text-muted transition hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary md:hidden"
        >
          <Menu className="size-4" aria-hidden="true" />
        </button>

        <Link
          href="/"
          aria-label={`${BRAND.productName} home`}
          className="flex items-center gap-2 rounded-xl px-1.5 py-1 transition hover:bg-[var(--glass-surface-subtle)]"
        >
          <BrandMark className="size-6" />
          <span className="hidden text-[13.5px] font-semibold tracking-[-0.02em] text-text-primary sm:inline">
            {BRAND.productName}
          </span>
        </Link>

        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="hidden size-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary md:flex"
        >
          {sidebarCollapsed ? (
            <ChevronsRight className="size-4" aria-hidden="true" />
          ) : (
            <ChevronsLeft className="size-4" aria-hidden="true" />
          )}
        </button>

        <span
          className="mx-0.5 hidden h-4 w-px bg-[var(--glass-border)] sm:block"
          aria-hidden="true"
        />

        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Navigate back"
          title="Back"
          className="hidden size-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary sm:flex"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => router.forward()}
          aria-label="Navigate forward"
          title="Forward"
          className="hidden size-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary sm:flex"
        >
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Center: Otter-style Global "Ask or search" Pill Bar */}
      <div className="flex max-w-[440px] flex-1 justify-center">
        <button
          type="button"
          onClick={openPalette}
          aria-label={`Ask or search (${modKey}K)`}
          className="glass-input flex h-8 w-full items-center gap-2 rounded-full px-3.5 text-left text-xs text-text-muted transition hover:border-[var(--glass-border-strong)] hover:text-text-primary"
        >
          <Search className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
          <span className="flex-1 truncate">Ask or search conversations…</span>
          <Kbd className="rounded-md">{modKey}K</Kbd>
        </button>
      </div>

      {/* Right: Contextual Actions + Primary Record / Share Button */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          className="glass-subtle flex size-8 items-center justify-center rounded-xl text-text-muted transition hover:text-text-primary"
        >
          <SunMoon className="size-3.5" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => void openHud()}
          aria-label="Open floating HUD recorder"
          title="Floating HUD recorder"
          className="glass-subtle hidden size-8 items-center justify-center rounded-xl text-text-muted transition hover:text-text-primary sm:flex"
        >
          <MonitorUp className="size-3.5" aria-hidden="true" />
        </button>

        {meeting ? (
          <>
            <button
              type="button"
              onClick={() => void handleCopySummary()}
              title="Copy Markdown summary"
              className="glass-subtle hidden h-8 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium text-text-primary transition hover:border-accent-primary/40 sm:inline-flex"
            >
              <Copy className="size-3.5 text-accent-primary" aria-hidden="true" />
              <span>Copy</span>
            </button>
            <Button
              variant="secondary"
              size="sm"
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
          </>
        ) : null}

        <Button
          variant="primary"
          size="sm"
          className="rounded-full px-3.5"
          leading={<Mic className="size-3.5" />}
          onClick={openNewRecording}
        >
          Record
        </Button>

        {showRightToggle && (
          <button
            type="button"
            onClick={toggleRightPanel}
            aria-label={rightPanelOpen ? "Collapse assistant panel" : "Expand assistant panel"}
            title={rightPanelOpen ? "Hide AI Assistant panel" : "Show AI Assistant panel"}
            className="glass-subtle hidden size-8 items-center justify-center rounded-xl text-text-muted transition hover:text-text-primary lg:flex"
          >
            {rightPanelOpen ? (
              <PanelRightClose className="size-3.5" aria-hidden="true" />
            ) : (
              <PanelRightOpen className="size-3.5" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </header>
  );
}
