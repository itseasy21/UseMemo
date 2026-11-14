import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type PillTone =
  "neutral" | "accent" | "secondary" | "success" | "warning" | "danger" | "outline";

const TONES: Record<PillTone, string> = {
  neutral: "border-border-subtle bg-bg-elevated text-text-muted",
  accent: "border-accent-primary/25 bg-accent-primary/10 text-accent-primary",
  secondary: "border-accent-secondary/25 bg-accent-secondary/10 text-accent-secondary",
  success: "border-accent-primary/25 bg-accent-primary/10 text-accent-primary",
  warning: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-recording-pulse/25 bg-recording-pulse/10 text-recording-pulse",
  outline: "border-border-subtle bg-transparent text-text-muted",
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
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4 tracking-[0.01em]",
        TONES[tone],
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}
