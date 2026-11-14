import { BRAND } from "@/generated/brand";
import { cn } from "@/lib/utils";

/** Inline rendition of the shipped brand mark (assets live outside the web root). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      role="img"
      aria-label={`${BRAND.productName} mark`}
      className={cn("size-8 shrink-0", className)}
    >
      <rect
        x="1"
        y="1"
        width="38"
        height="38"
        rx="11"
        fill="var(--brand-accent-primary)"
        fillOpacity="0.12"
        stroke="var(--brand-accent-primary)"
        strokeOpacity="0.34"
      />
      <rect
        x="10"
        y="8"
        width="20"
        height="24"
        rx="5"
        fill="none"
        stroke="var(--brand-text-muted)"
        strokeOpacity="0.6"
        strokeWidth="2"
      />
      <path
        d="M14.5 14.5h11M14.5 19h8"
        stroke="var(--brand-text-muted)"
        strokeOpacity="0.6"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M14 27h3l1.8 4 2.4-7 2 5 1.6-2H26"
        fill="none"
        stroke="var(--brand-accent-primary)"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({
  collapsed = false,
  className,
}: {
  collapsed?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <BrandMark className={collapsed ? "size-8" : "size-8"} />
      {!collapsed && (
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold tracking-[-0.025em] text-text-primary">
            {BRAND.productName}
          </span>
          <span className="mt-0.5 block truncate text-[8.5px] font-medium uppercase tracking-[0.18em] text-text-muted">
            {BRAND.tagline}
          </span>
        </span>
      )}
    </span>
  );
}
