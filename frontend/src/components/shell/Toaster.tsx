"use client";

import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, Sparkles, X } from "lucide-react";

import { useWorkspaceStore, type ToastItem } from "@/stores/workspace";
import { cn } from "@/lib/utils";

function ToastRow({ toast }: { toast: ToastItem }) {
  const dismissToast = useWorkspaceStore((state) => state.dismissToast);

  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), 4200);
    return () => window.clearTimeout(timer);
  }, [dismissToast, toast.id]);

  const Icon =
    toast.tone === "success"
      ? CheckCircle2
      : toast.tone === "danger"
        ? AlertTriangle
        : toast.tone === "accent"
          ? Sparkles
          : Info;

  return (
    <div
      role="status"
      className={cn(
        "glass pointer-events-auto flex w-[min(360px,calc(100vw-32px))] items-start gap-2.5 rounded-brand px-3.5 py-2.5 shadow-[0_18px_50px_-20px_oklch(0_0_0/0.65)]",
        toast.tone === "danger" && "border-recording-pulse/35",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          toast.tone === "success"
            ? "text-accent-primary"
            : toast.tone === "danger"
              ? "text-recording-pulse"
              : toast.tone === "accent"
                ? "text-accent-secondary"
                : "text-text-muted",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium leading-5 text-text-primary">{toast.message}</p>
        {toast.detail && (
          <p className="mt-0.5 text-[10.5px] leading-4 text-text-muted">{toast.detail}</p>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
        className="-mr-1 -mt-0.5 rounded p-1 text-text-muted transition hover:text-text-primary"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useWorkspaceStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
