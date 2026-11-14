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
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
        checked
          ? "border-accent-primary/40 bg-accent-primary/80"
          : "border-border-subtle bg-bg-primary/80",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block rounded-full bg-bg-primary shadow-sm transition-transform duration-200 dark:bg-text-primary",
          size === "sm" ? "size-3" : "size-4",
          checked ? (size === "sm" ? "translate-x-3.5" : "translate-x-[18px]") : "translate-x-0.5",
        )}
      />
    </button>
  );
}
