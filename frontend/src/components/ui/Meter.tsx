"use client";

import { cn } from "@/lib/utils";

export function Meter({
  value,
  label,
  color = "var(--brand-accent-primary)",
  segments = 18,
  muted = false,
  className,
}: {
  value: number;
  label: string;
  color?: string;
  segments?: number;
  muted?: boolean;
  className?: string;
}) {
  const normalized = Math.max(0, Math.min(1, muted ? 0 : value));
  const lit = Math.round(normalized * segments);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(normalized * 100)}
      className={cn("flex h-3 items-end gap-[2px]", className)}
    >
      {Array.from({ length: segments }).map((_, index) => {
        const active = index < lit;
        const height = 34 + ((index * 37) % 62);
        return (
          <span
            key={index}
            className="w-full rounded-[1px] transition-[height,opacity] duration-100"
            style={{
              height: `${height}%`,
              backgroundColor: active ? color : "var(--brand-border-subtle)",
              opacity: active ? (muted ? 0.3 : 0.9) : 0.45,
            }}
          />
        );
      })}
    </div>
  );
}
