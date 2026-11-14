"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
  bodyClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  className?: string;
  bodyClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(
        "[autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])",
      );
      target?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-[oklch(0.08_0.01_255/0.62)] p-4 pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          "glass relative w-full overflow-hidden rounded-[calc(var(--radius-brand)+4px)] shadow-[0_40px_120px_-30px_oklch(0_0_0/0.65)]",
          SIZES[size],
          className,
        )}
      >
        <header className="flex items-start justify-between gap-6 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-[15px] font-semibold tracking-[-0.01em] text-text-primary"
            >
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-xs leading-5 text-text-muted">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close dialog" size="sm" onClick={() => onOpenChange(false)}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className={cn("max-h-[62vh] overflow-y-auto p-5", bodyClassName)}>{children}</div>
        {footer && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle bg-bg-primary/25 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
