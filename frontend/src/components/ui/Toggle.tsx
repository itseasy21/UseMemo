"use client";

import { cn } from "@/lib/utils";

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  size = "md",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full border transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "h-5 w-9" : "h-6 w-11",
        checked
          ? "border-accent-primary/50 bg-accent-primary shadow-[0_0_12px_-2px_color-mix(in_oklab,var(--brand-accent-primary)_55%,transparent)]"
          : "border-[var(--glass-border-strong)] bg-[var(--glass-surface-subtle)]",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-sm transition-transform duration-200",
          size === "sm" ? "size-3.5" : "size-4.5",
          checked ? (size === "sm" ? "translate-x-4" : "translate-x-5") : "translate-x-0.5",
        )}
      />
    </button>
  );
}
