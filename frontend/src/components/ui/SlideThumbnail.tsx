"use client";

import { useState } from "react";

import { slideAccent, slideBackground } from "@/lib/display";
import type { Screenshot } from "@/lib/demo-data";
import { cn } from "@/lib/utils";

export function SlideThumbnail({
  screenshot,
  compact = false,
  className,
  showTime = true,
}: {
  screenshot: Screenshot;
  compact?: boolean;
  className?: string;
  showTime?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const accent = slideAccent(screenshot.palette);

  if (screenshot.assetUrl && !imageFailed) {
    return (
      <div
        className={cn(
          "relative isolate flex overflow-hidden rounded-[5px] border border-border-subtle bg-bg-primary text-text-primary",
          compact ? "aspect-[16/10]" : "aspect-[16/9]",
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={screenshot.assetUrl}
          alt={`${screenshot.title}, captured slide`}
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="size-full object-cover"
        />
        {showTime && screenshot.caption && (
          <span className="tabular pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-xs">
            {screenshot.caption}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={`${screenshot.title}, captured slide`}
      className={cn(
        "relative isolate flex flex-col overflow-hidden rounded-[5px] border border-border-subtle text-text-primary",
        compact ? "aspect-[16/10]" : "aspect-[16/9]",
        className,
      )}
      style={{ background: slideBackground(screenshot.palette) }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
          backgroundSize: compact ? "16px 16px" : "24px 24px",
          maskImage: "radial-gradient(ellipse at top left, black, transparent 75%)",
        }}
      />
      <div
        className={cn(
          "relative flex items-center justify-between gap-2 border-b border-white/10",
          compact ? "px-1.5 py-0.5" : "px-2.5 py-1.5",
        )}
      >
        <span
          className={cn(
            "font-mono uppercase tracking-[0.14em] text-text-muted",
            compact ? "text-[9px]" : "text-[10px]",
          )}
        >
          Slide
        </span>
        {showTime && (
          <span className={cn("tabular text-text-muted", compact ? "text-[9px]" : "text-[10px]")}>
            {screenshot.caption}
          </span>
        )}
      </div>
      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col",
          compact ? "gap-0.5 p-1.5" : "gap-1.5 p-3",
        )}
      >
        <span
          className="mb-auto block rounded-full"
          style={{
            width: compact ? 18 : 30,
            height: compact ? 2 : 3,
            backgroundColor: accent,
            opacity: 0.85,
          }}
        />
        <p
          className={cn(
            "max-w-[94%] truncate font-semibold leading-tight tracking-[-0.02em]",
            compact ? "text-[10px]" : "text-[13px]",
          )}
        >
          {screenshot.title}
        </p>
        {!compact && (
          <p className="line-clamp-2 max-w-[96%] text-[11px] leading-[1.45] text-text-muted">
            {screenshot.slideText}
          </p>
        )}
      </div>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-8 -right-8 size-20 rounded-full opacity-20 blur-2xl"
        style={{ backgroundColor: accent }}
      />
    </div>
  );
}
