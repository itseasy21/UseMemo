"use client";

import { create } from "zustand";

import { DEFAULT_THEME_MODE, type ThemeMode } from "@/generated/brand";

export type ToastTone = "default" | "success" | "danger" | "accent";

export type ToastItem = {
  id: string;
  message: string;
  detail?: string;
  tone: ToastTone;
};

type WorkspaceState = {
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  newRecordingOpen: boolean;
  theme: ThemeMode;
  toasts: ToastItem[];
  speakerLabels: Record<string, string>;
  selectedModelId: string;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  openNewRecording: () => void;
  closeNewRecording: () => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  pushToast: (message: string, detail?: string, tone?: ToastTone) => void;
  dismissToast: (id: string) => void;
  setSpeakerLabel: (meetingId: string, speakerId: string, label: string) => void;
  resetSpeakerLabel: (meetingId: string, speakerId: string) => void;
  setSelectedModel: (modelId: string) => void;
};

let toastCounter = 0;

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  sidebarCollapsed: false,
  paletteOpen: false,
  newRecordingOpen: false,
  theme: DEFAULT_THEME_MODE,
  toasts: [],
  speakerLabels: {},
  selectedModelId: "gemma-4-e4b-it",
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  openNewRecording: () => set({ newRecordingOpen: true, paletteOpen: false }),
  closeNewRecording: () => set({ newRecordingOpen: false }),
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((state) => ({ theme: state.theme === "dark" ? "light" : "dark" })),
  pushToast: (message, detail, tone = "default") => {
    toastCounter += 1;
    const id = `toast-${Date.now()}-${toastCounter}`;
    set((state) => ({ toasts: [...state.toasts.slice(-2), { id, message, detail, tone }] }));
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  setSpeakerLabel: (meetingId, speakerId, label) =>
    set((state) => ({
      speakerLabels: {
        ...state.speakerLabels,
        [`${meetingId}:${speakerId}`]: label,
      },
    })),
  resetSpeakerLabel: (meetingId, speakerId) =>
    set((state) => {
      const next = { ...state.speakerLabels };
      delete next[`${meetingId}:${speakerId}`];
      return { speakerLabels: next };
    }),
  setSelectedModel: (selectedModelId) => set({ selectedModelId }),
}));

export function speakerLabel(
  labels: Record<string, string>,
  meetingId: string,
  speakerId: string,
  fallback: string,
): string {
  return labels[`${meetingId}:${speakerId}`]?.trim() || fallback;
}
