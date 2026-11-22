"use client";

import { useEffect, useState } from "react";
import { Radio } from "lucide-react";

import {
  callDetectionStatus,
  resetCallDetectionApps,
  setCallDetectionEnabled,
  type CallDetectionStatusRecord,
} from "@/lib/host";
import { useHostEvent } from "@/hooks/use-host-event";
import { HOST_EVENTS, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export function CallDetectionToggle() {
  const [status, setStatus] = useState<CallDetectionStatusRecord | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    void (async () => {
      const current = await callDetectionStatus();
      if (!current) return;
      setStatus(current);
    })();
  }, []);

  useHostEvent(HOST_EVENTS.callDetectionSettingsChanged, setStatus);

  if (!status?.supported) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        role="switch"
        aria-checked={status.enabled}
        onClick={() => {
          const enabled = !status.enabled;
          setStatus({ ...status, enabled });
          void setCallDetectionEnabled(enabled).then((next) => {
            if (next) setStatus(next);
          });
        }}
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] px-3 py-2 text-left"
        title={status.detail}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Radio className="size-3.5 shrink-0 text-accent-primary" aria-hidden="true" />
          <span>
            <span className="block text-[11px] font-medium text-text-primary">
              Suggest recordings
            </span>
            <span className="block text-[10px] text-text-muted">When a call app uses your mic</span>
          </span>
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full border transition",
            status.enabled
              ? "border-accent-primary/60 bg-accent-primary/35"
              : "border-[var(--glass-border-strong)] bg-[var(--glass-surface)]",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-transform",
              status.enabled ? "translate-x-[17px]" : "translate-x-0.5",
            )}
          />
        </span>
      </button>
      {status.ignoredApps.length > 0 && (
        <button
          type="button"
          onClick={() => {
            void resetCallDetectionApps().then((next) => {
              if (next) setStatus(next);
            });
          }}
          className="mt-1.5 w-full text-center text-[10px] text-text-muted hover:text-text-primary"
        >
          Allow prompts from {status.ignoredApps.length} ignored{" "}
          {status.ignoredApps.length === 1 ? "app" : "apps"}
        </button>
      )}
    </div>
  );
}
