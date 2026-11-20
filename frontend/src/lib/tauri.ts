/**
 * Typed bridge to the Tauri host.
 *
 * The UI is a static Next export and also runs in a plain browser (design
 * preview, docs, CI visual checks). Every native call is guarded by `isTauri()`
 * so browser previews fall back cleanly while Tauri runtime failures surface
 * typed `HostError` instances instead of silently disappearing.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

export class HostError extends Error {
  readonly command: string;

  constructor(command: string, cause: unknown) {
    const raw =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : JSON.stringify(cause ?? "unknown host error");
    super(raw || `Host command "${command}" failed`);
    this.name = "HostError";
    this.command = command;
  }
}

export function formatHostError(error: unknown, fallback = "Local host operation failed."): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

export type AudioLevelsPayload = {
  meetingId: string;
  channel: string;
  rmsDbfs: number;
  peakDbfs: number;
  atMs: number;
  echoBleed?: boolean;
  deviceError?: string | null;
};

export type AsrSegmentDeltaPayload = {
  meetingId: string;
  seqNo: number;
  startMs: number;
  endMs: number;
  speakerLabel: string;
  text: string;
  isFinal: boolean;
};

export type ScreenshotTrigger = "interval" | "manual" | "slide-change";

export type ScreenshotRecord = {
  id: string;
  meetingId: string;
  startMs: number;
  endMs: number;
  filePath: string;
  width: number;
  height: number;
  dhash: string;
  captureTrigger: string;
  ocrExtractedText: string | null;
};

export type ScreenshotCapturedPayload = {
  meetingId: string;
  screenshot: ScreenshotRecord | null;
  deduplicated: boolean;
  reason: string;
};

/** Backend stages are `context`, `generating`, `verifying`, `complete`, `failed`. */
export type SynthesisProgressPayload = {
  meetingId: string;
  stage: string;
  percent: number;
  message: string | null;
};

/** Progress of a post-recording transcription run. Stages: `loading`,
 * `transcribing`, `complete`, `failed`. */
export type AsrProgressPayload = {
  meetingId: string;
  stage: string;
  percent: number;
  segments: number;
  processedMs: number;
  totalMs: number;
};

export type MeetingRecord = {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  audioFilePath: string | null;
  systemAudioFilePath: string | null;
  systemAudioStartedAtMs: number;
  diarizationEnabled: boolean;
  screenshotIntervalSec: number;
  asrModelId: string;
  slmModelId: string;
  manualNotesRawMd: string;
  folderId: string | null;
  isStarred: boolean;
};

export type MeetingChangedPayload = {
  meeting: MeetingRecord;
};

/** Facts about the loopback archive of a take. */
export type SystemAudioFacts = {
  path: string;
  startedAtMs: number;
  durationMs: number;
  silent: boolean;
  droppedBlocks: number;
  peakDbfs: number;
  error: string | null;
};

/** Emitted when a take is finalized, with facts the meeting row cannot carry. */
export type RecordingStoppedPayload = {
  meetingId: string;
  durationMs: number;
  path: string | null;
  silent: boolean;
  droppedBlocks: number;
  peakDbfs: number;
  system: SystemAudioFacts | null;
  systemError: string | null;
  error: string | null;
};

export type DownloadPhase = "downloading" | "verifying" | "complete";

export type ModelDownloadProgressPayload = {
  artifactId: string;
  filename: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  phase: DownloadPhase;
};

export type TrayActionPayload = {
  action: string;
  microphone: string;
};

export type TrayMicrophonePayload = {
  microphone: string;
  label: string;
};

export type HostEventMap = {
  "audio:levels": AudioLevelsPayload;
  "asr:segment-delta": AsrSegmentDeltaPayload;
  "asr:progress": AsrProgressPayload;
  "screenshot:captured": ScreenshotCapturedPayload;
  "synthesis:progress": SynthesisProgressPayload;
  "models:download-progress": ModelDownloadProgressPayload;
  "meeting:changed": MeetingChangedPayload;
  "recording:stopped": RecordingStoppedPayload;
  "tray:action": TrayActionPayload;
  "tray:microphone-changed": TrayMicrophonePayload;
};

export const HOST_EVENTS = {
  audioLevels: "audio:levels",
  asrSegmentDelta: "asr:segment-delta",
  asrProgress: "asr:progress",
  screenshotCaptured: "screenshot:captured",
  synthesisProgress: "synthesis:progress",
  modelDownloadProgress: "models:download-progress",
  meetingChanged: "meeting:changed",
  recordingStopped: "recording:stopped",
  trayAction: "tray:action",
  trayMicrophoneChanged: "tray:microphone-changed",
} as const satisfies Record<string, keyof HostEventMap>;

export type UnlistenFn = () => void;

/** True only inside a Tauri webview (v2 exposes `__TAURI_INTERNALS__`). */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || Boolean((window as { isTauri?: boolean }).isTauri))
  );
}

/**
 * Convert a local vault media file path (`.wav`, `.webp`) into a Tauri
 * `asset://` URL scoped to `$DATA/<storageDirName>/media/**`.
 */
export function toAssetUrl(filePath: string | null | undefined): string | null {
  if (!filePath || !isTauri()) return null;
  try {
    return convertFileSrc(filePath);
  } catch {
    return null;
  }
}

/**
 * Invoke a host command with strict error propagation when running inside Tauri.
 *
 * - Browser preview (`!isTauri()`): resolves to `null` so callers can render demo data.
 * - Tauri host (`isTauri()`): resolves to `T`, or throws `HostError` with the Rust message.
 */
export async function invokeHost<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, args);
  } catch (error) {
    throw new HostError(command, error);
  }
}

/**
 * Soft read-only probe: returns `null` outside Tauri or if an optional background
 * query fails, logging a diagnostic warning instead of crashing an effect.
 */
export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, args);
  } catch (error) {
    console.warn(`[memo] invoke("${command}") failed`, error);
    return null;
  }
}

/**
 * Invoke a host command that requires Tauri and always throws `HostError` on failure.
 */
export async function invokeRequired<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) {
    throw new HostError(command, "Tauri host runtime is not available in browser preview");
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, args);
  } catch (error) {
    throw new HostError(command, error);
  }
}

/**
 * Subscribe to one typed host event. Always resolves to a disposer, even when
 * running in the browser, so effects can clean up unconditionally.
 */
export async function listenEvent<K extends keyof HostEventMap>(
  event: K,
  handler: (payload: HostEventMap[K]) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<HostEventMap[K]>(event, (hostEvent) => handler(hostEvent.payload));
  } catch (error) {
    console.warn(`[memo] listen("${event}") failed`, error);
    return () => undefined;
  }
}

/** Convenience wrapper around a single host command + browser fallback. */
export async function invokeWithFallback<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: T,
): Promise<T> {
  const result = await invokeCommand<T>(command, args);
  return result ?? fallback;
}
