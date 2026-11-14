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
  const accent = slideAccent(screenshot.palette);
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
          compact ? "px-1.5 py-1" : "px-2.5 py-1.5",
        )}
      >
        <span
          className={cn(
            "font-mono uppercase tracking-[0.16em] text-text-muted",
            compact ? "text-[6px]" : "text-[8px]",
          )}
        >
          Slide
        </span>
        {showTime && (
          <span className={cn("tabular text-text-muted", compact ? "text-[6px]" : "text-[8px]")}>
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
            "max-w-[92%] font-semibold leading-tight tracking-[-0.02em]",
            compact ? "text-[8px]" : "text-[13px]",
          )}
        >
          {screenshot.title}
        </p>
        {!compact && (
          <p className="line-clamp-2 max-w-[96%] text-[8.5px] leading-[1.45] text-text-muted">
            {screenshot.slideText}
          </p>
        )}
        <div className="mt-1 flex items-end gap-1" aria-hidden="true">
          {[42, 60, 30, 74, 48].map((width, index) => (
            <span
              key={index}
              className="block rounded-full bg-text-muted/35"
              style={{ width: compact ? width / 4 : width, height: compact ? 1 : 2 }}
            />
          ))}
        </div>
      </div>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-8 -right-8 size-20 rounded-full opacity-20 blur-2xl"
        style={{ backgroundColor: accent }}
      />
    </div>
  );
}
