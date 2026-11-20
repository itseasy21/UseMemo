"use client";

import { useState } from "react";
import { Mic2, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { useHostEvent } from "@/hooks/use-host-event";
import { setCallDetectionAppEnabled } from "@/lib/host";
import { HOST_EVENTS, type CallDetectedPayload } from "@/lib/tauri";
import { useWorkspaceStore } from "@/stores/workspace";

export function CallDetectionPrompt() {
  const [detected, setDetected] = useState<CallDetectedPayload | null>(null);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);

  useHostEvent(HOST_EVENTS.callDetected, setDetected);
  useHostEvent(HOST_EVENTS.callEnded, (payload) => {
    setDetected((current) => (current?.callId === payload.callId ? null : current));
  });

  if (!detected) return null;

  return (
    <aside
      aria-live="polite"
      aria-label={`${detected.appName} call detected`}
      className="fixed right-4 top-20 z-[90] w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-[var(--glass-border-strong)] bg-[var(--glass-surface-strong)] p-4 text-text-primary shadow-[0_24px_80px_-24px_rgba(0,0,0,.72)] backdrop-blur-2xl"
    >
      <button
        type="button"
        aria-label="Dismiss call prompt"
        onClick={() => setDetected(null)}
        className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-lg text-text-muted hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
      <div className="flex items-start gap-3 pr-7">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary/15 text-accent-primary">
          <Mic2 className="size-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold">
            {detected.confidence >= 0.8
              ? `${detected.appName} call detected`
              : `${detected.appName} is using your microphone`}
          </p>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            Start a private local recording? Tell everyone before recording.
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setDetected(null);
            openNewRecording();
          }}
        >
          Start recording
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDetected(null)}>
          Not now
        </Button>
        <button
          type="button"
          onClick={() => {
            void setCallDetectionAppEnabled(detected.appId, false);
            setDetected(null);
          }}
          className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text-primary"
        >
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          Never for {detected.appName}
        </button>
      </div>
    </aside>
  );
}
