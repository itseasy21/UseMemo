"use client";

import { Menu, Plus, Search } from "lucide-react";

import { Sidebar } from "@/components/shell/Sidebar";
import { BrandMark, Wordmark } from "@/components/ui/Brand";
import { BRAND } from "@/generated/brand";
import { useWorkspaceStore } from "@/stores/workspace";

export function AppShell({ children }: { children: React.ReactNode }) {
  const openPalette = useWorkspaceStore((state) => state.openPalette);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg-primary">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3 md:hidden">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Open navigation"
            className="flex size-8 items-center justify-center rounded-brand text-text-muted hover:bg-bg-elevated hover:text-text-primary"
          >
            <Menu className="size-4" />
          </button>
          <span className="flex min-w-0 items-center gap-2" aria-label={BRAND.productName}>
            <BrandMark className="size-6" />
            <Wordmark collapsed />
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={openPalette}
              aria-label="Search vault"
              className="flex size-8 items-center justify-center rounded-brand text-text-muted hover:bg-bg-elevated"
            >
              <Search className="size-4" />
            </button>
            <button
              type="button"
              onClick={openNewRecording}
              aria-label="New recording"
              className="flex size-8 items-center justify-center rounded-brand bg-accent-primary text-bg-primary"
            >
              <Plus className="size-4" />
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
