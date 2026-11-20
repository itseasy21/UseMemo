"use client";

import { useBrand } from "@/components/providers/BrandProvider";
import { cn } from "@/lib/utils";

/** Dynamic brand mark driven by `--brand-*` CSS tokens and runtime manifest. */
export function BrandMark({ className }: { className?: string }) {
  const brand = useBrand();
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label={`${brand.productName} mark`}
      className={cn("size-8 shrink-0", className)}
    >
      <defs>
        <linearGradient id="usememo-mark" x1="7" y1="6" x2="41" y2="43">
          <stop stopColor="var(--brand-accent-primary)" />
          <stop offset="1" stopColor="var(--brand-accent-secondary)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="14" fill="#071216" />
      <path d="M12 10h18l8 8v19a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="url(#usememo-mark)" />
      <path d="M30 10v5a3 3 0 0 0 3 3h5" fill="#aef9f0" fillOpacity=".82" />
      <path
        d="M8 29h5c2.6 0 2.8-5 5.1-5 2.5 0 2.4 9 4.9 9s2.6-14 5.2-14 2.5 16 5 16c2.4 0 2.7-9 5-9 2 0 2.3 4.3 4.4 4.3 1.4 0 2.2-1.8 3.4-3.1"
        fill="none"
        stroke="#efffff"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({
  collapsed = false,
  showTagline = true,
  className,
}: {
  collapsed?: boolean;
  showTagline?: boolean;
  className?: string;
}) {
  const brand = useBrand();
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <BrandMark className="size-9" />
      {!collapsed && (
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold tracking-[-0.035em] text-text-primary">
            {brand.productName}
          </span>
          {showTagline ? (
            <span className="mt-0.5 block truncate text-[9px] font-semibold uppercase tracking-[0.18em] text-text-muted">
              {brand.tagline}
            </span>
          ) : null}
        </span>
      )}
    </span>
  );
}
