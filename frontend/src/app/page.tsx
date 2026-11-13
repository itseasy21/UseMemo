import { ArrowRight, LockKeyhole, Mic } from "lucide-react";

import { BRAND } from "@/generated/brand";

export default function HomePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-8">
      <section className="glass w-full max-w-2xl rounded-[calc(var(--radius-brand)+8px)] p-10 shadow-2xl">
        <div className="mb-6 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
          <LockKeyhole className="size-3.5 text-accent-primary" />
          Offline mode enforced
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-balance">{BRAND.productName}</h1>
        <p className="mt-3 max-w-lg text-sm leading-6 text-text-muted">{BRAND.tagline}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-[var(--radius-brand)] bg-accent-primary px-4 py-2.5 text-sm font-semibold text-[oklch(0.16_0.02_165)] transition hover:brightness-110"
          >
            <Mic className="size-4" />
            Start recording
            <kbd className="tabular ml-2 rounded border border-black/20 px-1.5 py-0.5 text-[10px]">⌘N</kbd>
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-[var(--radius-brand)] border border-border-subtle px-4 py-2.5 text-sm font-medium text-text-primary transition hover:bg-bg-elevated"
          >
            Open vault
            <ArrowRight className="size-4" />
          </button>
        </div>
        <p className="tabular mt-8 text-xs text-text-muted">
          Scaffold online · LiteRT runtime pending model provisioning
        </p>
      </section>
    </main>
  );
}
