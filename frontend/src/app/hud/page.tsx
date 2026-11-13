import { BRAND } from "@/generated/brand";

export default function HudPage() {
  return (
    <main className="flex h-dvh w-screen items-center justify-center bg-transparent p-2">
      <div className="glass flex w-full items-center gap-3 rounded-full px-4 py-2">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-recording-pulse opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-recording-pulse" />
        </span>
        <span className="tabular text-sm font-medium">00:00</span>
        <span className="truncate text-xs text-text-muted">{BRAND.productName} HUD</span>
      </div>
    </main>
  );
}
