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

export type HomeRightTab = "chat" | "meetings" | "actions";
export type MeetingRightTab = "chat" | "notes" | "assist";

type WorkspaceState = {
  sidebarCollapsed: boolean;
  mobileNavOpen: boolean;
  paletteOpen: boolean;
  newRecordingOpen: boolean;
  activeFolderFilter: string;
  rightPanelOpen: boolean;
  homeRightTab: HomeRightTab;
  meetingRightTab: MeetingRightTab;
  aiPromptRequest: { text: string; nonce: number } | null;
  theme: ThemeMode;
  toasts: ToastItem[];
  speakerLabels: Record<string, string>;
  selectedModelId: string;
  selectedAsrModelId: string;
  selectedMicrophone: string;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  openMobileNav: () => void;
  closeMobileNav: () => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  openNewRecording: () => void;
  closeNewRecording: () => void;
  setActiveFolderFilter: (folderId: string) => void;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  setHomeRightTab: (tab: HomeRightTab) => void;
  setMeetingRightTab: (tab: MeetingRightTab) => void;
  triggerAiPrompt: (text: string) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  pushToast: (message: string, detail?: string, tone?: ToastTone) => void;
  dismissToast: (id: string) => void;
  setSpeakerLabel: (meetingId: string, speakerId: string, label: string) => void;
  resetSpeakerLabel: (meetingId: string, speakerId: string) => void;
  setSelectedModel: (modelId: string) => void;
  setSelectedAsrModel: (modelId: string) => void;
  setSelectedMicrophone: (microphone: string) => void;
};

let toastCounter = 0;
let promptNonce = 0;

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  sidebarCollapsed: false,
  mobileNavOpen: false,
  paletteOpen: false,
  newRecordingOpen: false,
  activeFolderFilter: "all",
  rightPanelOpen: true,
  homeRightTab: "chat",
  meetingRightTab: "chat",
  aiPromptRequest: null,
  theme: DEFAULT_THEME_MODE,
  toasts: [],
  speakerLabels: {},
  selectedModelId: "qwen3.5-4b",
  selectedAsrModelId: "whisper-small",
  selectedMicrophone: "",
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  openMobileNav: () => set({ mobileNavOpen: true }),
  closeMobileNav: () => set({ mobileNavOpen: false }),
  openPalette: () => set({ paletteOpen: true, mobileNavOpen: false }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  openNewRecording: () => set({ newRecordingOpen: true, paletteOpen: false, mobileNavOpen: false }),
  closeNewRecording: () => set({ newRecordingOpen: false }),
  setActiveFolderFilter: (activeFolderFilter) => set({ activeFolderFilter }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  setHomeRightTab: (homeRightTab) => set({ homeRightTab, rightPanelOpen: true }),
  setMeetingRightTab: (meetingRightTab) => set({ meetingRightTab, rightPanelOpen: true }),
  triggerAiPrompt: (text) => {
    promptNonce += 1;
    set({
      rightPanelOpen: true,
      homeRightTab: "chat",
      meetingRightTab: "chat",
      aiPromptRequest: { text, nonce: promptNonce },
    });
  },
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
  setSelectedAsrModel: (selectedAsrModelId) => set({ selectedAsrModelId }),
  setSelectedMicrophone: (selectedMicrophone) => set({ selectedMicrophone }),
}));

export function speakerLabel(
  labels: Record<string, string>,
  meetingId: string,
  speakerId: string,
  fallback: string,
): string {
  return labels[`${meetingId}:${speakerId}`]?.trim() || fallback;
}
