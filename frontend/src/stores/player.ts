"use client";

import { create } from "zustand";

type PlayerState = {
  currentMs: number;
  durationMs: number;
  isPlaying: boolean;
  initialize: (durationMs: number, startMs?: number) => void;
  seek: (ms: number) => void;
  setCurrentMs: (ms: number) => void;
  tick: (deltaMs: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
};

export const usePlayerStore = create<PlayerState>((set) => ({
  currentMs: 0,
  durationMs: 0,
  isPlaying: false,
  initialize: (durationMs, startMs = 0) =>
    set({
      durationMs,
      currentMs: Math.max(0, Math.min(durationMs, startMs)),
      isPlaying: false,
    }),
  seek: (ms) =>
    set((state) => ({
      currentMs: Math.max(0, Math.min(state.durationMs || ms, ms)),
    })),
  setCurrentMs: (ms) => set({ currentMs: Math.max(0, ms) }),
  tick: (deltaMs) =>
    set((state) => {
      const next = Math.min(state.durationMs, state.currentMs + deltaMs);
      return { currentMs: next, isPlaying: next < state.durationMs ? state.isPlaying : false };
    }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  togglePlaying: () =>
    set((state) => {
      if (state.currentMs >= state.durationMs) {
        return { currentMs: 0, isPlaying: true };
      }
      return { isPlaying: !state.isPlaying };
    }),
}));
