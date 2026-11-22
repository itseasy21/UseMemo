"use client";

import { create } from "zustand";

export type PlaybackSpeed = 1 | 1.25 | 1.5 | 2;

type LoadMediaParams = {
  meetingId: string;
  durationMs: number;
  startMs?: number;
  micSrc?: string | null;
  systemSrc?: string | null;
  systemOffsetMs?: number;
};

type PlayerState = {
  meetingId: string | null;
  currentMs: number;
  durationMs: number;
  isPlaying: boolean;
  hasRealAudio: boolean;
  hasSystemTrack: boolean;
  playbackRate: PlaybackSpeed;
  micMuted: boolean;
  sysMuted: boolean;
  micGain: number;
  sysGain: number;
  audioError: string | null;
  initialize: (durationMs: number, startMs?: number) => void;
  loadMedia: (params: LoadMediaParams) => void;
  teardown: () => void;
  seek: (ms: number) => void;
  setCurrentMs: (ms: number) => void;
  tick: (deltaMs: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setPlaybackRate: (rate: PlaybackSpeed) => void;
  cyclePlaybackRate: () => void;
  setMicMuted: (muted: boolean) => void;
  setSysMuted: (muted: boolean) => void;
  setMicGain: (gain: number) => void;
  setSysGain: (gain: number) => void;
};

const SPEEDS: PlaybackSpeed[] = [1, 1.25, 1.5, 2];

class DualTrackEngine {
  private micEl: HTMLAudioElement | null = null;
  private sysEl: HTMLAudioElement | null = null;
  private systemOffsetMs = 0;
  private rafId: number | null = null;
  private onUpdate: ((ms: number, durationMs?: number, ended?: boolean) => void) | null = null;
  private onError: ((message: string) => void) | null = null;

  attach(
    micSrc: string | null | undefined,
    systemSrc: string | null | undefined,
    systemOffsetMs: number,
    initialMs: number,
    options: {
      playbackRate: PlaybackSpeed;
      micMuted: boolean;
      sysMuted: boolean;
      micGain: number;
      sysGain: number;
    },
    onUpdate: (ms: number, durationMs?: number, ended?: boolean) => void,
    onError: (message: string) => void,
  ): boolean {
    this.dispose();
    if (typeof window === "undefined") return false;
    if (!micSrc && !systemSrc) return false;

    this.systemOffsetMs = Math.max(0, systemOffsetMs || 0);
    this.onUpdate = onUpdate;
    this.onError = onError;

    if (micSrc) {
      const audio = new Audio();
      audio.preload = "metadata";
      audio.src = micSrc;
      audio.playbackRate = options.playbackRate;
      audio.muted = options.micMuted;
      audio.volume = clamp01(options.micGain);
      audio.addEventListener("loadedmetadata", () => {
        const dur = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0;
        if (initialMs > 0) {
          audio.currentTime = Math.min(audio.duration || initialMs / 1000, initialMs / 1000);
        }
        if (dur > 0) this.onUpdate?.(Math.round(audio.currentTime * 1000), dur, false);
      });
      audio.addEventListener("ended", () => {
        this.stopSyncLoop();
        this.sysEl?.pause();
        const dur = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined;
        this.onUpdate?.(dur ?? Math.round(audio.currentTime * 1000), dur, true);
      });
      audio.addEventListener("error", () => {
        this.onError?.("Could not decode local microphone WAV archive.");
      });
      this.micEl = audio;
    }

    if (systemSrc) {
      const sys = new Audio();
      sys.preload = "metadata";
      sys.src = systemSrc;
      sys.playbackRate = options.playbackRate;
      sys.muted = options.sysMuted;
      sys.volume = clamp01(options.sysGain);
      sys.addEventListener("loadedmetadata", () => {
        const sysTargetSec = Math.max(0, (initialMs - this.systemOffsetMs) / 1000);
        if (sysTargetSec > 0) {
          sys.currentTime = Math.min(sys.duration || sysTargetSec, sysTargetSec);
        }
        if (!this.micEl && Number.isFinite(sys.duration) && sys.duration > 0) {
          const totalDur = Math.round(sys.duration * 1000) + this.systemOffsetMs;
          this.onUpdate?.(initialMs, totalDur, false);
        }
      });
      sys.addEventListener("ended", () => {
        if (!this.micEl) {
          this.stopSyncLoop();
          const dur = Number.isFinite(sys.duration)
            ? Math.round(sys.duration * 1000) + this.systemOffsetMs
            : undefined;
          this.onUpdate?.(dur ?? 0, dur, true);
        }
      });
      sys.addEventListener("error", () => {
        this.onError?.("Could not decode local system-audio WAV archive.");
      });
      this.sysEl = sys;
    }

    return true;
  }

  private currentMasterMs(): number {
    if (this.micEl) {
      return Math.round(this.micEl.currentTime * 1000);
    }
    if (this.sysEl) {
      return Math.round(this.sysEl.currentTime * 1000) + this.systemOffsetMs;
    }
    return 0;
  }

  private syncSecondary(masterMs: number, wantPlaying: boolean) {
    if (!this.micEl || !this.sysEl) return;
    if (masterMs < this.systemOffsetMs) {
      if (!this.sysEl.paused) this.sysEl.pause();
      if (this.sysEl.currentTime !== 0) {
        try {
          this.sysEl.currentTime = 0;
        } catch {
          // Metadata may still be loading.
        }
      }
      return;
    }
    const desiredSec = (masterMs - this.systemOffsetMs) / 1000;
    const maxSec = Number.isFinite(this.sysEl.duration) ? this.sysEl.duration : desiredSec + 1;
    if (desiredSec >= maxSec) {
      if (!this.sysEl.paused) this.sysEl.pause();
      return;
    }
    if (Math.abs(this.sysEl.currentTime - desiredSec) > 0.085) {
      try {
        this.sysEl.currentTime = desiredSec;
      } catch {
        // Ignore seek before metadata is ready.
      }
    }
    if (wantPlaying && this.sysEl.paused) {
      void this.sysEl.play().catch(() => undefined);
    }
  }

  private startSyncLoop() {
    this.stopSyncLoop();
    const step = () => {
      const ms = this.currentMasterMs();
      this.syncSecondary(ms, true);
      this.onUpdate?.(ms, undefined, false);
      this.rafId = window.requestAnimationFrame(step);
    };
    this.rafId = window.requestAnimationFrame(step);
  }

  private stopSyncLoop() {
    if (this.rafId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  async play(): Promise<boolean> {
    const master = this.micEl ?? this.sysEl;
    if (!master) return false;
    try {
      await master.play();
      this.syncSecondary(this.currentMasterMs(), true);
      this.startSyncLoop();
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Audio playback was blocked";
      this.onError?.(msg);
      return false;
    }
  }

  pause() {
    this.stopSyncLoop();
    this.micEl?.pause();
    this.sysEl?.pause();
  }

  seek(ms: number) {
    const safeMs = Math.max(0, ms);
    if (this.micEl) {
      try {
        const targetSec = safeMs / 1000;
        this.micEl.currentTime = Number.isFinite(this.micEl.duration)
          ? Math.min(this.micEl.duration, targetSec)
          : targetSec;
      } catch {
        // Metadata not yet ready.
      }
    }
    if (this.sysEl) {
      try {
        const sysSec = Math.max(0, (safeMs - this.systemOffsetMs) / 1000);
        this.sysEl.currentTime = Number.isFinite(this.sysEl.duration)
          ? Math.min(this.sysEl.duration, sysSec)
          : sysSec;
      } catch {
        // Metadata not yet ready.
      }
    }
  }

  setPlaybackRate(rate: PlaybackSpeed) {
    if (this.micEl) this.micEl.playbackRate = rate;
    if (this.sysEl) this.sysEl.playbackRate = rate;
  }

  setMicMuted(muted: boolean) {
    if (this.micEl) this.micEl.muted = muted;
  }

  setSysMuted(muted: boolean) {
    if (this.sysEl) this.sysEl.muted = muted;
  }

  setMicGain(gain: number) {
    if (this.micEl) this.micEl.volume = clamp01(gain);
  }

  setSysGain(gain: number) {
    if (this.sysEl) this.sysEl.volume = clamp01(gain);
  }

  dispose() {
    this.stopSyncLoop();
    if (this.micEl) {
      this.micEl.pause();
      this.micEl.removeAttribute("src");
      this.micEl.load();
      this.micEl = null;
    }
    if (this.sysEl) {
      this.sysEl.pause();
      this.sysEl.removeAttribute("src");
      this.sysEl.load();
      this.sysEl = null;
    }
    this.onUpdate = null;
    this.onError = null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

const audioEngine = new DualTrackEngine();

export const usePlayerStore = create<PlayerState>((set, get) => ({
  meetingId: null,
  currentMs: 0,
  durationMs: 0,
  isPlaying: false,
  hasRealAudio: false,
  hasSystemTrack: false,
  playbackRate: 1,
  micMuted: false,
  sysMuted: false,
  micGain: 1,
  sysGain: 1,
  audioError: null,

  initialize: (durationMs, startMs = 0) => {
    audioEngine.dispose();
    set({
      meetingId: null,
      durationMs: Math.max(0, durationMs),
      currentMs: Math.max(0, Math.min(Math.max(0, durationMs), startMs)),
      isPlaying: false,
      hasRealAudio: false,
      hasSystemTrack: false,
      audioError: null,
    });
  },

  loadMedia: ({ meetingId, durationMs, startMs = 0, micSrc, systemSrc, systemOffsetMs = 0 }) => {
    const state = get();
    const clampedStart = Math.max(0, durationMs > 0 ? Math.min(durationMs, startMs) : startMs);
    const attached = audioEngine.attach(
      micSrc,
      systemSrc,
      systemOffsetMs,
      clampedStart,
      {
        playbackRate: state.playbackRate,
        micMuted: state.micMuted,
        sysMuted: state.sysMuted,
        micGain: state.micGain,
        sysGain: state.sysGain,
      },
      (ms, detectedDurationMs, ended) => {
        set((current) => ({
          currentMs: ms,
          durationMs:
            detectedDurationMs !== undefined
              ? Math.max(current.durationMs, detectedDurationMs)
              : current.durationMs,
          isPlaying: ended ? false : current.isPlaying,
        }));
      },
      (message) => {
        set({ audioError: message, isPlaying: false });
      },
    );

    set({
      meetingId,
      durationMs: Math.max(0, durationMs),
      currentMs: clampedStart,
      isPlaying: false,
      hasRealAudio: attached,
      hasSystemTrack: Boolean(systemSrc),
      audioError: null,
    });
  },

  teardown: () => {
    audioEngine.dispose();
    set({ isPlaying: false, hasRealAudio: false, hasSystemTrack: false });
  },

  seek: (ms) => {
    const state = get();
    const clamped = Math.max(0, state.durationMs > 0 ? Math.min(state.durationMs, ms) : ms);
    if (state.hasRealAudio) {
      audioEngine.seek(clamped);
    }
    set({ currentMs: clamped });
  },

  setCurrentMs: (ms) => set({ currentMs: Math.max(0, ms) }),

  tick: (deltaMs) => {
    const state = get();
    if (state.hasRealAudio) return;
    if (state.durationMs <= 0) {
      set({ isPlaying: false });
      return;
    }
    const scaledDelta = deltaMs * state.playbackRate;
    const next = Math.min(state.durationMs, state.currentMs + scaledDelta);
    set({ currentMs: next, isPlaying: next < state.durationMs ? state.isPlaying : false });
  },

  setPlaying: (wantPlaying) => {
    const state = get();
    if (!wantPlaying) {
      if (state.hasRealAudio) audioEngine.pause();
      set({ isPlaying: false });
      return;
    }
    if (state.durationMs > 0 && state.currentMs >= state.durationMs) {
      if (state.hasRealAudio) audioEngine.seek(0);
      set({ currentMs: 0 });
    }
    if (state.hasRealAudio) {
      void audioEngine.play().then((started) => {
        set({ isPlaying: started });
      });
    } else if (state.durationMs > 0) {
      set({ isPlaying: true });
    }
  },

  togglePlaying: () => {
    const state = get();
    state.setPlaying(!state.isPlaying);
  },

  setPlaybackRate: (playbackRate) => {
    audioEngine.setPlaybackRate(playbackRate);
    set({ playbackRate });
  },

  cyclePlaybackRate: () => {
    const current = get().playbackRate;
    const nextIndex = (SPEEDS.indexOf(current) + 1) % SPEEDS.length;
    const next = SPEEDS[nextIndex];
    audioEngine.setPlaybackRate(next);
    set({ playbackRate: next });
  },

  setMicMuted: (micMuted) => {
    audioEngine.setMicMuted(micMuted);
    set({ micMuted });
  },

  setSysMuted: (sysMuted) => {
    audioEngine.setSysMuted(sysMuted);
    set({ sysMuted });
  },

  setMicGain: (micGain) => {
    const safe = clamp01(micGain);
    audioEngine.setMicGain(safe);
    set({ micGain: safe });
  },

  setSysGain: (sysGain) => {
    const safe = clamp01(sysGain);
    audioEngine.setSysGain(safe);
    set({ sysGain: safe });
  },
}));
