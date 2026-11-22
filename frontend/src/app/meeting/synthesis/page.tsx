"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronLeft, Loader2 } from "lucide-react";

import { SynthesisCanvas } from "@/components/synthesis/SynthesisCanvas";
import { Button, buttonClass } from "@/components/ui/Button";
import { BRAND } from "@/generated/brand";
import { useLiveMeeting } from "@/hooks/use-live-meeting";

function SynthesisQueryView() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const { meeting, loading, notFound, error, reload, mutateMeeting } = useLiveMeeting(id);

  useEffect(() => {
    if (meeting?.title) {
      document.title = `${meeting.title} · Synthesis · ${BRAND.productName}`;
    }
  }, [meeting?.title]);

  if (loading && !meeting) {
    return (
      <main className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-bg-primary px-6 text-center">
        <Loader2 className="size-6 animate-spin text-accent-primary" aria-hidden="true" />
        <p className="text-sm font-medium text-text-primary">Loading grounded synthesis…</p>
        <p className="text-xs text-text-muted">Reading verified claims and evidence citations.</p>
      </main>
    );
  }

  if (notFound || (!meeting && !error)) {
    return (
      <main className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-bg-primary px-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated text-text-muted">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Meeting not found</h1>
          <p className="mt-1 max-w-md text-xs leading-5 text-text-muted">
            This memo is not in the local vault or may have been deleted.
          </p>
        </div>
        <Link href="/" className={buttonClass({ variant: "primary", size: "md" })}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          Back to vault
        </Link>
      </main>
    );
  }

  if (error || !meeting) {
    return (
      <main className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-bg-primary px-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-full border border-recording-pulse/30 bg-recording-pulse/10 text-recording-pulse">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Could not open synthesis</h1>
          <p className="mt-1 max-w-md text-xs leading-5 text-text-muted">{error}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/" className={buttonClass({ variant: "secondary", size: "md" })}>
            Back to vault
          </Link>
          <Button variant="primary" size="md" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      </main>
    );
  }

  return <SynthesisCanvas meeting={meeting} onReload={reload} onMutate={mutateMeeting} />;
}

export default function MeetingSynthesisQueryPage() {
  return (
    <Suspense
      fallback={
        <main className="flex h-dvh w-full items-center justify-center bg-bg-primary">
          <Loader2 className="size-6 animate-spin text-accent-primary" aria-hidden="true" />
        </main>
      }
    >
      <SynthesisQueryView />
    </Suspense>
  );
}
