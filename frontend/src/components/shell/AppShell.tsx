"use client";

import { useCallback, useEffect, useId, useRef } from "react";

import { RightAssistantPanel } from "@/components/shell/RightAssistantPanel";
import { Sidebar, SidebarSheetContent } from "@/components/shell/Sidebar";
import { TopHeaderBar } from "@/components/shell/TopHeaderBar";
import type { Meeting } from "@/lib/demo-data";
import { useWorkspaceStore } from "@/stores/workspace";

export function AppShell({
  children,
  meeting,
  activeSpeakerId,
  currentMs,
  onReload,
  onMutate,
  rightMode = "home",
}: {
  children: React.ReactNode;
  meeting?: Meeting;
  activeSpeakerId?: string | null;
  currentMs?: number;
  onReload?: () => Promise<void>;
  onMutate?: (updater: (current: Meeting) => Meeting) => void;
  rightMode?: "home" | "meeting" | "none";
}) {
  const mobileNavOpen = useWorkspaceStore((state) => state.mobileNavOpen);
  const closeMobileNav = useWorkspaceStore((state) => state.closeMobileNav);

  const drawerId = useId();
  const drawerRef = useRef<HTMLDialogElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const slideOutDrawer = useCallback(() => {
    const scroller = scrollerRef.current;
    const dialog = drawerRef.current;
    if (!scroller || !dialog || !dialog.open) {
      closeMobileNav();
      return;
    }
    scroller.scrollTo({ left: scroller.offsetWidth, behavior: "auto" });
  }, [closeMobileNav]);

  useEffect(() => {
    const dialog = drawerRef.current;
    const scroller = scrollerRef.current;
    const sheet = sheetRef.current;
    if (!dialog || !scroller || !sheet) return;

    if (!mobileNavOpen) {
      if (dialog.open) dialog.close();
      return;
    }

    let cancelled = false;
    void (async () => {
      if (!dialog.open) {
        dialog.showModal();
      }
      if (typeof CSS !== "undefined" && !CSS.supports("scroll-initial-target", "nearest")) {
        scroller.scrollTo({ left: scroller.offsetWidth, behavior: "instant" });
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
        );
      }
      if (!cancelled) {
        scroller.scrollTo({ left: 0, behavior: "auto" });
      }
    })();

    const visibleThreshold = Math.max(0.002, 1 / Math.max(320, window.innerWidth));
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        if (entry.intersectionRatio < visibleThreshold && dialog.open) {
          dialog.close();
          closeMobileNav();
        }
      },
      { root: dialog, threshold: [visibleThreshold, 1] },
    );
    observer.observe(sheet);

    const supportsScrollTimeline =
      typeof CSS !== "undefined" && CSS.supports("animation-timeline: scroll()");
    const handleScroll = () => {
      if (sheet.offsetWidth <= 0) return;
      const ratio = Math.max(0, Math.min(1, 1 - scroller.scrollLeft / sheet.offsetWidth));
      dialog.style.setProperty("--drawer-backdrop", String(ratio));
    };
    if (!supportsScrollTimeline) {
      scroller.addEventListener("scroll", handleScroll, { passive: true });
      handleScroll();
    }

    const handleCancel = (event: Event) => {
      if (event.cancelable) {
        event.preventDefault();
        slideOutDrawer();
      } else {
        closeMobileNav();
      }
    };

    dialog.addEventListener("cancel", handleCancel);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (!supportsScrollTimeline) {
        scroller.removeEventListener("scroll", handleScroll);
      }
      dialog.removeEventListener("cancel", handleCancel);
    };
  }, [closeMobileNav, mobileNavOpen, slideOutDrawer]);

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-transparent">
      <TopHeaderBar meeting={meeting} drawerId={drawerId} showRightToggle={rightMode !== "none"} />

      {/* Native top-layer scroll-snap drawer for mobile viewports */}
      <dialog
        id={drawerId}
        ref={drawerRef}
        aria-label="Navigation drawer"
        onClick={(event) => {
          if (sheetRef.current && !sheetRef.current.contains(event.target as Node)) {
            slideOutDrawer();
          }
        }}
        className="um-drawer md:hidden"
      >
        <div ref={scrollerRef} className="um-drawer-scroller">
          <div ref={sheetRef} className="um-drawer-sheet">
            <SidebarSheetContent onClose={slideOutDrawer} />
          </div>
        </div>
      </dialog>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
        {rightMode !== "none" && (
          <RightAssistantPanel
            mode={rightMode}
            meeting={meeting}
            activeSpeakerId={activeSpeakerId}
            currentMs={currentMs}
            onReload={onReload}
            onMutate={onMutate}
          />
        )}
      </div>
    </div>
  );
}
