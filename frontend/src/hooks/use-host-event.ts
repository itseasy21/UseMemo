"use client";

import { useEffect, useRef } from "react";

import {
  HOST_EVENTS,
  listenEvent,
  type AsrSegmentDeltaPayload,
  type AudioLevelsPayload,
  type HostEventMap,
  type MeetingChangedPayload,
  type ModelDownloadProgressPayload,
  type ScreenshotCapturedPayload,
  type SynthesisProgressPayload,
  type UnlistenFn,
} from "@/lib/tauri";

type Handler<K extends keyof HostEventMap> = (payload: HostEventMap[K]) => void;

/**
 * Subscribe to one typed host event.
 *
 * The latest handler is kept in a ref so callers do not have to memoize it.
 * Browser previews resolve to a no-op disposer, which keeps every effect
 * unconditional and SSR-safe.
 */
export function useHostEvent<K extends keyof HostEventMap>(
  event: K,
  handler: Handler<K>,
  enabled = true,
): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listenEvent(event, (payload) => {
      if (!disposed) handlerRef.current(payload);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, event]);
}

export function useAudioLevels(handler: (payload: AudioLevelsPayload) => void, enabled = true) {
  useHostEvent(HOST_EVENTS.audioLevels, handler, enabled);
}

export function useAsrSegmentDeltas(
  handler: (payload: AsrSegmentDeltaPayload) => void,
  enabled = true,
) {
  useHostEvent(HOST_EVENTS.asrSegmentDelta, handler, enabled);
}

export function useScreenshotCaptured(
  handler: (payload: ScreenshotCapturedPayload) => void,
  enabled = true,
) {
  useHostEvent(HOST_EVENTS.screenshotCaptured, handler, enabled);
}

export function useSynthesisProgress(
  handler: (payload: SynthesisProgressPayload) => void,
  enabled = true,
) {
  useHostEvent(HOST_EVENTS.synthesisProgress, handler, enabled);
}

export function useModelDownloadProgress(
  handler: (payload: ModelDownloadProgressPayload) => void,
  enabled = true,
) {
  useHostEvent(HOST_EVENTS.modelDownloadProgress, handler, enabled);
}

export function useMeetingChanged(
  handler: (payload: MeetingChangedPayload) => void,
  enabled = true,
) {
  useHostEvent(HOST_EVENTS.meetingChanged, handler, enabled);
}
