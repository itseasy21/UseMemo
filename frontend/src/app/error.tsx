"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";

import { Button, buttonClass } from "@/components/ui/Button";
import { BRAND } from "@/generated/brand";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(`[${BRAND.brandId}] route error`, error);
  }, [error]);

  return (
    <main className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-bg-primary px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full border border-recording-pulse/30 bg-recording-pulse/10 text-recording-pulse">
        <AlertTriangle className="size-5" aria-hidden="true" />
      </span>
      <div className="max-w-md">
        <h1 className="text-lg font-semibold text-text-primary">Something interrupted this view</h1>
        <p className="mt-1.5 text-xs leading-5 text-text-muted">
          {error.message || "Your local vault files remain intact on disk."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link href="/" className={buttonClass({ variant: "secondary", size: "md" })}>
          Return to vault
        </Link>
        <Button
          variant="primary"
          size="md"
          leading={<RotateCcw className="size-3.5" />}
          onClick={reset}
        >
          Try again
        </Button>
      </div>
    </main>
  );
}
