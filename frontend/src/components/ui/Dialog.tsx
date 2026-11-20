"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-[620px]",
  xl: "max-w-4xl",
} as const;

let supportsDisplayTransition: boolean | undefined;
function canTransitionDisplay(): boolean {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (
    typeof window === "undefined" ||
    !window.CSS?.supports?.("transition-behavior", "allow-discrete") ||
    !document.body
  ) {
    return false;
  }
  const probe = document.createElement("div");
  probe.style.cssText = "transition: display 1s allow-discrete !important; display: block;";
  document.body.appendChild(probe);
  void getComputedStyle(probe).display;
  probe.style.display = "none";
  supportsDisplayTransition = getComputedStyle(probe).display === "block";
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.CSS?.supports?.("overlay", "auto")) &&
    canTransitionDisplay()
  );
}

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressedOutsideRef = useRef(false);
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  const titleId = useId();
  const descriptionId = useId();

  const requestClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || !dialog.open) {
      closeRef.current(false);
      return;
    }
    if (!supportsTopLayerExit()) {
      dialog.setAttribute("data-closing", "");
      const animations = dialog.getAnimations({ subtree: true });
      if (animations.length > 0) {
        void Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise((r) => window.setTimeout(r, 220)),
        ]).then(() => {
          dialog.removeAttribute("data-closing");
          if (dialog.open) dialog.close();
          closeRef.current(false);
        });
        return;
      }
      dialog.removeAttribute("data-closing");
    }
    if (dialog.open) dialog.close();
    closeRef.current(false);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      dialog.removeAttribute("data-closing");
      if (!dialog.open) {
        dialog.showModal();
      }
      const raf = window.requestAnimationFrame(() => {
        const target = dialog.querySelector<HTMLElement>(
          "[autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])",
        );
        target?.focus();
      });
      return () => window.cancelAnimationFrame(raf);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;

    const handleCancel = (event: Event) => {
      event.preventDefault();
      requestClose();
    };

    const handleClose = () => {
      dialog.returnValue = "";
      closeRef.current(false);
    };

    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleClose);
    };
  }, [open, requestClose]);

  if (!open) return null;

  const isOutsideDialogBounds = (clientX: number, clientY: number, el: HTMLDialogElement) => {
    const rect = el.getBoundingClientRect();
    return (
      clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom
    );
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      {...({ closedby: "any" } as Record<string, string>)}
      onPointerDown={(event) => {
        if (typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype) {
          return;
        }
        pressedOutsideRef.current = isOutsideDialogBounds(
          event.clientX,
          event.clientY,
          event.currentTarget,
        );
      }}
      onPointerUp={(event) => {
        if (typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype) {
          return;
        }
        if (
          pressedOutsideRef.current &&
          isOutsideDialogBounds(event.clientX, event.clientY, event.currentTarget)
        ) {
          requestClose();
        }
        pressedOutsideRef.current = false;
      }}
      className={cn(
        "um-modal m-auto mt-[6vh] w-[calc(100%-2rem)] overflow-hidden rounded-[28px] border border-[var(--glass-border-strong)] bg-[var(--glass-surface-strong)] p-0 text-text-primary shadow-[0_40px_120px_-36px_rgba(0,0,0,.72)]",
        SIZES[size],
        className,
      )}
    >
      <header className="flex items-start justify-between gap-6 border-b border-[var(--glass-border)] px-7 py-6">
        <div className="min-w-0">
          <h2
            id={titleId}
            className="text-[20px] font-semibold tracking-[-0.035em] text-text-primary"
          >
            {title}
          </h2>
          {description && (
            <p
              id={descriptionId}
              className="mt-1.5 max-w-[560px] text-[13px] leading-5 text-text-muted"
            >
              {description}
            </p>
          )}
        </div>
        <IconButton label="Close dialog" size="sm" onClick={requestClose}>
          <X className="size-4" aria-hidden="true" />
        </IconButton>
      </header>
      <div className={cn("max-h-[68vh] overflow-y-auto px-7 py-6", bodyClassName)}>{children}</div>
      {footer && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--glass-border)] bg-[color-mix(in_oklab,var(--glass-surface-subtle)_75%,transparent)] px-7 py-4">
          {footer}
        </footer>
      )}
    </dialog>
  );
}
