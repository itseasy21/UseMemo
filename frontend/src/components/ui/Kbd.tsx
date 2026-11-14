import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Kbd({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <kbd
      title={title}
      className={cn(
        "tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border-subtle bg-bg-primary/55 px-1 text-[9.5px] font-medium leading-none text-text-muted shadow-[inset_0_-1px_0_oklch(0_0_0/0.08)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function KbdGroup({ keys, label }: { keys: string[]; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={label}>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}
