"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { CommandPalette } from "@/components/shell/CommandPalette";
import { NewRecordingDialog } from "@/components/shell/NewRecordingDialog";
import { Toaster } from "@/components/shell/Toaster";
import { useWorkspaceStore } from "@/stores/workspace";

export function GlobalOverlays() {
  const pathname = usePathname();
  const isHud = Boolean(pathname?.startsWith("/hud"));
  const togglePalette = useWorkspaceStore((state) => state.togglePalette);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const closePalette = useWorkspaceStore((state) => state.closePalette);
  const paletteOpen = useWorkspaceStore((state) => state.paletteOpen);

  useEffect(() => {
    if (isHud) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        togglePalette();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        openNewRecording();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHud, openNewRecording, togglePalette]);

  useEffect(() => {
    if (isHud && paletteOpen) closePalette();
  }, [closePalette, isHud, paletteOpen]);

  if (isHud) return null;

  return (
    <>
      <CommandPalette />
      <NewRecordingDialog />
      <Toaster />
    </>
  );
}
