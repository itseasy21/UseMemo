/**
 * Typed, fail-soft bridge to the Tauri host.
 *
 * The UI is a static Next export and also runs in a plain browser (design
 * preview, docs, CI screenshots). Every native call is therefore guarded by
 * `isTauri()` and the Tauri packages are imported lazily so the browser bundle
 * never tries to resolve a runtime that is not there.
 */

export type AudioLevelsPayload = {
  meetingId: string;
  channel: string;
  rmsDbfs: number;
  peakDbfs: number;
  atMs: number;
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

export type MeetingRecord = {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  audioFilePath: string | null;
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

export type DownloadPhase = "downloading" | "verifying" | "complete";

export type ModelDownloadProgressPayload = {
  artifactId: string;
  filename: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  phase: DownloadPhase;
};

export type HostEventMap = {
  "audio:levels": AudioLevelsPayload;
  "asr:segment-delta": AsrSegmentDeltaPayload;
  "screenshot:captured": ScreenshotCapturedPayload;
  "synthesis:progress": SynthesisProgressPayload;
  "models:download-progress": ModelDownloadProgressPayload;
  "meeting:changed": MeetingChangedPayload;
};

export const HOST_EVENTS = {
  audioLevels: "audio:levels",
  asrSegmentDelta: "asr:segment-delta",
  screenshotCaptured: "screenshot:captured",
  synthesisProgress: "synthesis:progress",
  modelDownloadProgress: "models:download-progress",
  meetingChanged: "meeting:changed",
} as const satisfies Record<string, keyof HostEventMap>;

export type UnlistenFn = () => void;

/** True only inside a Tauri webview (v2 exposes `__TAURI_INTERNALS__`). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Invoke a host command. In the browser this resolves to `null` instead of
 * throwing so callers can fall back to the local demo vault. Host errors are
 * logged and also return `null`; a future transport-error channel can surface
 * them to the UI without changing call sites.
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
