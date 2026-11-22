"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export type PopoverTriggerProps = {
  onClick: () => void;
  "aria-expanded": boolean;
  "aria-haspopup": "dialog";
  "aria-controls": string;
};

export function Popover({
  label,
  trigger,
  children,
  align = "start",
  className,
  panelClassName,
}: {
  label: string;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end" | "center";
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        wrapperRef.current?.querySelector<HTMLElement>("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={wrapperRef} className={cn("relative inline-flex", className)}>
      {trigger({
        onClick: () => setOpen((value) => !value),
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        "aria-controls": id,
      })}
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          className={cn(
            "panel absolute top-[calc(100%+6px)] z-[70] min-w-48 overflow-hidden p-3 shadow-[0_24px_60px_-20px_oklch(0_0_0/0.55)]",
            align === "start" && "left-0",
            align === "end" && "right-0",
            align === "center" && "left-1/2 -translate-x-1/2",
            panelClassName,
          )}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
