import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type PillTone =
  "neutral" | "accent" | "secondary" | "success" | "warning" | "danger" | "outline";

const TONES: Record<PillTone, string> = {
  neutral:
    "border-[var(--glass-border-strong)] bg-[var(--glass-surface-subtle)] text-text-muted backdrop-blur-sm",
  accent:
    "border-accent-primary/30 bg-accent-primary/12 text-accent-primary shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_12%,transparent)]",
  secondary:
    "border-accent-secondary/30 bg-accent-secondary/12 text-accent-secondary shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_12%,transparent)]",
  success:
    "border-accent-primary/30 bg-accent-primary/12 text-accent-primary shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_12%,transparent)]",
  warning: "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300",
  danger: "border-recording-pulse/30 bg-recording-pulse/12 text-recording-pulse",
  outline: "border-[var(--glass-border-strong)] bg-transparent text-text-muted",
};

export function Pill({
  children,
  tone = "neutral",
  className,
  icon,
  title,
}: {
  children: ReactNode;
  tone?: PillTone;
  className?: string;
  icon?: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10.5px] font-medium leading-4 tracking-[0.01em]",
        TONES[tone],
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}
