"use client";

import Link from "next/link";
import { ChevronLeft, ShieldCheck } from "lucide-react";

import { buttonClass } from "@/components/ui/Button";
import { BRAND } from "@/generated/brand";

export default function NotFound() {
  return (
    <main className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-bg-primary px-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated text-accent-primary">
        <ShieldCheck className="size-5" aria-hidden="true" />
      </span>
      <div className="max-w-md">
        <h1 className="text-lg font-semibold text-text-primary">Page not found</h1>
        <p className="mt-1.5 text-xs leading-5 text-text-muted">
          The requested view could not be found in {BRAND.productName}.
        </p>
      </div>
      <Link href="/" className={buttonClass({ variant: "primary", size: "md" })}>
        <ChevronLeft className="size-4" aria-hidden="true" />
        Back to vault
      </Link>
    </main>
  );
}
