"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { useBrand } from "@/components/providers/BrandProvider";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { CallDetectionPrompt } from "@/components/shell/CallDetectionPrompt";
import { NewRecordingDialog } from "@/components/shell/NewRecordingDialog";
import { Toaster } from "@/components/shell/Toaster";
import { useHostEvent } from "@/hooks/use-host-event";
import { HOST_EVENTS } from "@/lib/tauri";
import { useWorkspaceStore } from "@/stores/workspace";

export function GlobalOverlays() {
  const pathname = usePathname();
  const isHud = Boolean(pathname?.startsWith("/hud"));
  const brand = useBrand();
  const togglePalette = useWorkspaceStore((state) => state.togglePalette);
  const openPalette = useWorkspaceStore((state) => state.openPalette);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const closePalette = useWorkspaceStore((state) => state.closePalette);
  const closeNewRecording = useWorkspaceStore((state) => state.closeNewRecording);
  const closeMobileNav = useWorkspaceStore((state) => state.closeMobileNav);
  const paletteOpen = useWorkspaceStore((state) => state.paletteOpen);
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const setSelectedMicrophone = useWorkspaceStore((state) => state.setSelectedMicrophone);

  useHostEvent(
    HOST_EVENTS.trayAction,
    (payload) => {
      if (payload.action === "start-recording") {
        if (typeof payload.microphone === "string") {
          setSelectedMicrophone(payload.microphone);
        }
        openNewRecording();
      }
    },
    !isHud,
  );

  useHostEvent(
    HOST_EVENTS.callAccepted,
    () => {
      openNewRecording();
    },
    !isHud,
  );

  useHostEvent(
    HOST_EVENTS.trayMicrophoneChanged,
    (payload) => {
      setSelectedMicrophone(payload.microphone);
      pushToast("Microphone selected", payload.label, "accent");
    },
    !isHud,
  );

  const ctrlXArmedAtRef = useRef<number>(0);

  useEffect(() => {
    if (isHud) return;
    const gnuEnabled = Boolean(brand.features.enableGnuKeybindings);

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      // Optional GNU Emacs keybindings (`C-x C-s` save buffer, `C-g` keyboard-quit, `C-s` isearch)
      if (gnuEnabled && event.ctrlKey && !event.metaKey && !event.altKey) {
        if (key === "x") {
          event.preventDefault();
          ctrlXArmedAtRef.current = Date.now();
          return;
        }
        if (key === "s" && Date.now() - ctrlXArmedAtRef.current < 1_500) {
          event.preventDefault();
          ctrlXArmedAtRef.current = 0;
          window.dispatchEvent(new CustomEvent("memo:save-notes"));
          pushToast("Buffer saved (C-x C-s)", "Manual notes flushed to SQLite.", "success");
          return;
        }
        if (key === "g") {
          event.preventDefault();
          ctrlXArmedAtRef.current = 0;
          closePalette();
          closeNewRecording();
          closeMobileNav();
          return;
        }
        if (key === "s") {
          const target = event.target as HTMLElement | null;
          const inEditor =
            target?.tagName === "INPUT" ||
            target?.tagName === "TEXTAREA" ||
            target?.isContentEditable;
          if (!inEditor) {
            event.preventDefault();
            openPalette();
            return;
          }
        }
      }

      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      if (key === "k") {
        event.preventDefault();
        togglePalette();
      } else if (key === "n") {
        event.preventDefault();
        openNewRecording();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    brand.features.enableGnuKeybindings,
    closeMobileNav,
    closeNewRecording,
    closePalette,
    isHud,
    openNewRecording,
    openPalette,
    pushToast,
    togglePalette,
  ]);

  useEffect(() => {
    if (isHud && paletteOpen) closePalette();
  }, [closePalette, isHud, paletteOpen]);

  if (isHud) return null;

  return (
    <>
      <CommandPalette />
      <CallDetectionPrompt />
      <NewRecordingDialog />
      <Toaster />
    </>
  );
}
