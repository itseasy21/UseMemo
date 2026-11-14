"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, ScanText, Sparkles } from "lucide-react";

import { Pill } from "@/components/ui/Pill";
import { SlideThumbnail } from "@/components/ui/SlideThumbnail";
import type { Screenshot } from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ScreenshotCard({
  screenshot,
  className,
}: {
  screenshot: Screenshot;
  className?: string;
}) {
  const [extracted, setExtracted] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const extract = () => {
    if (extracted) {
      setExtracted(false);
      return;
    }
    setExtracting(true);
    timerRef.current = window.setTimeout(() => {
      setExtracting(false);
      setExtracted(true);
      timerRef.current = null;
    }, 620);
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[7px] border border-border-subtle bg-bg-elevated/55",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border-subtle bg-bg-primary/25 px-2.5 py-1.5">
        <Camera className="size-3 text-accent-secondary" />
        <span className="text-[9.5px] font-medium text-text-primary">Slide Changed</span>
        <span className="text-[9px] text-text-muted">•</span>
        <span className="tabular text-[9px] text-text-muted">
          {formatTimestamp(screenshot.startMs)}
        </span>
        <Pill tone="secondary" className="ml-auto px-1.5 py-0">
          {screenshot.trigger === "slide-change" ? "vision trigger" : `${screenshot.trigger} · 10s`}
        </Pill>
      </div>
      <div className="flex gap-2.5 p-2.5">
        <SlideThumbnail screenshot={screenshot} compact className="w-[122px] shrink-0 self-start" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-[10.5px] font-medium text-text-primary">{screenshot.title}</p>
          <p className="mt-0.5 line-clamp-2 text-[9px] leading-4 text-text-muted">
            {screenshot.slideText}
          </p>
          <div className="mt-auto flex items-center gap-1.5 pt-1.5">
            <button
              type="button"
              onClick={extract}
              disabled={extracting}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-border-subtle bg-bg-primary/40 px-2 text-[9px] font-medium text-text-muted transition hover:border-accent-secondary/30 hover:text-text-primary disabled:opacity-60"
            >
              {extracting ? (
                <Loader2 className="size-2.5 animate-spin" />
              ) : (
                <ScanText className="size-2.5" />
              )}
              {extracting ? "Extracting…" : extracted ? "Hide slide text" : "Extract Slide Text"}
            </button>
            <span className="ml-auto hidden items-center gap-1 text-[8px] text-text-muted/60 sm:flex">
              <Sparkles className="size-2.5" />
              WebP · deduped
            </span>
          </div>
        </div>
      </div>
      {extracted && (
        <div className="border-t border-border-subtle bg-bg-primary/30 px-2.5 py-2">
          <p className="mb-1 flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.12em] text-accent-secondary">
            <ScanText className="size-2.5" /> slide text · OCR
          </p>
          <p className="text-[9.5px] leading-4 text-text-muted">{screenshot.slideText}</p>
        </div>
      )}
    </div>
  );
}
