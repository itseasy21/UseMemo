"use client";

import { BRAND } from "@/generated/brand";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-[#14171f] px-6 text-center text-[#f4f6fb]">
        <h1 className="text-lg font-semibold">{BRAND.productName} encountered a UI error</h1>
        <p className="max-w-md text-xs leading-5 text-[#9ca3b5]">
          {error.message || "Your local recordings and SQLite database remain safe on disk."}
        </p>
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-[#34d399] px-4 py-2 text-xs font-semibold text-[#14171f]"
        >
          Reload view
        </button>
      </body>
    </html>
  );
}
