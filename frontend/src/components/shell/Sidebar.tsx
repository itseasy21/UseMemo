"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  House,
  ListChecks,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { BRAND } from "@/generated/brand";
import { useMeetingChanged } from "@/hooks/use-host-event";
import { MEETINGS } from "@/lib/demo-data";
import { createFolder, deleteFolder, listFolders, type FolderRecord } from "@/lib/host";
import { isImeComposing } from "@/lib/ime";
import { localDeviceNoun } from "@/lib/platform";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

export function SidebarSheetContent({ onClose }: { onClose?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const collapsed = useWorkspaceStore((state) => state.sidebarCollapsed) && !onClose;
  const activeFolderFilter = useWorkspaceStore((state) => state.activeFolderFilter);
  const setActiveFolderFilter = useWorkspaceStore((state) => state.setActiveFolderFilter);
  const setHomeRightTab = useWorkspaceStore((state) => state.setHomeRightTab);
  const setMeetingRightTab = useWorkspaceStore((state) => state.setMeetingRightTab);
  const setRightPanelOpen = useWorkspaceStore((state) => state.setRightPanelOpen);
  const pushToast = useWorkspaceStore((state) => state.pushToast);

  const [deviceNoun, setDeviceNoun] = useState("this device");
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [foldersExpanded, setFoldersExpanded] = useState(true);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");

  const loadFolders = useCallback(async () => {
    if (!isTauri()) {
      setFolders(
        Array.from(new Set(MEETINGS.map((m) => m.folder))).map((name) => ({
          id: `demo-folder-${name.toLowerCase()}`,
          name,
          parentId: null,
          createdAt: Date.now(),
        })),
      );
      return;
    }
    const rows = await listFolders();
    if (rows) setFolders(rows);
  }, []);

  useEffect(() => {
    setDeviceNoun(localDeviceNoun());
    void loadFolders();
  }, [loadFolders]);

  useMeetingChanged(() => {
    void loadFolders();
  });

  const handleCreateFolder = async () => {
    const trimmed = folderDraft.trim();
    if (!trimmed) return;
    if (!isTauri()) {
      setFolders((curr) => [
        ...curr,
        { id: `demo-${Date.now()}`, name: trimmed, parentId: null, createdAt: Date.now() },
      ]);
      setFolderDraft("");
      setCreatingFolder(false);
      return;
    }
    try {
      const created = await createFolder(trimmed);
      if (created) {
        setFolders((curr) => [...curr, created]);
        setActiveFolderFilter(created.id);
        setFolderDraft("");
        setCreatingFolder(false);
        pushToast("Folder created", created.name, "success");
      }
    } catch (err) {
      pushToast("Could not create folder", formatHostError(err), "danger");
    }
  };

  const handleDeleteFolder = async (folder: FolderRecord) => {
    if (!isTauri()) {
      setFolders((curr) => curr.filter((f) => f.id !== folder.id));
      if (activeFolderFilter === folder.id) setActiveFolderFilter("all");
      return;
    }
    try {
      await deleteFolder(folder.id);
      if (activeFolderFilter === folder.id) setActiveFolderFilter("all");
      await loadFolders();
      pushToast("Folder removed", `Memos in "${folder.name}" were kept in your vault.`, "default");
    } catch (err) {
      pushToast("Could not remove folder", formatHostError(err), "danger");
    }
  };

  const isHome = pathname === "/";
  const isModels = Boolean(pathname?.startsWith("/models"));
  const isMeetingPage = Boolean(pathname?.startsWith("/meeting"));

  const selectFolderAndGoHome = (folderId: string) => {
    setActiveFolderFilter(folderId);
    onClose?.();
    if (!isHome) {
      router.push("/");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className={cn("shrink-0 px-3 pb-4 pt-5", collapsed && "px-2")}>
        {collapsed ? (
          <div className="flex justify-center">
            <Avatar name={BRAND.productName} tone="accent" size="sm" />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2.5 px-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar name={BRAND.productName} tone="accent" size="sm" />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold tracking-[-0.01em] text-text-primary">
                  Personal vault
                </p>
                <p className="truncate text-[10px] font-medium uppercase tracking-[0.1em] text-text-muted">
                  Private on {deviceNoun}
                </p>
              </div>
            </div>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close navigation menu"
                className="flex size-7 items-center justify-center rounded-lg text-text-muted hover:text-text-primary"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Primary Navigation */}
      <nav
        className={cn("min-h-0 flex-1 overflow-y-auto px-3", collapsed && "px-2")}
        aria-label="Primary"
      >
        {!collapsed && (
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted/65">
            Workspace
          </p>
        )}
        <div className="space-y-1.5">
          {/* Home */}
          <button
            type="button"
            onClick={() => selectFolderAndGoHome("all")}
            title={collapsed ? "Home" : undefined}
            className={cn(
              "group flex h-10 w-full items-center gap-3 rounded-xl border px-3 text-[13px] font-medium transition",
              isHome && activeFolderFilter === "all"
                ? "border-accent-primary/20 bg-gradient-to-r from-accent-primary/16 to-accent-secondary/[0.06] text-text-primary shadow-[inset_3px_0_0_var(--brand-accent-primary)]"
                : "border-transparent text-text-muted hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary",
              collapsed && "justify-center px-0",
            )}
          >
            <House
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                isHome && activeFolderFilter === "all"
                  ? "text-accent-primary"
                  : "text-text-muted group-hover:text-text-primary",
              )}
            />
            {!collapsed && <span className="truncate">Home</span>}
          </button>

          {/* AI Chat */}
          <button
            type="button"
            onClick={() => {
              setRightPanelOpen(true);
              if (isMeetingPage) {
                setMeetingRightTab("chat");
              } else {
                setHomeRightTab("chat");
                if (!isHome) router.push("/");
              }
              onClose?.();
            }}
            title={collapsed ? "AI Chat" : undefined}
            className={cn(
              "group flex h-10 w-full items-center gap-3 rounded-xl border border-transparent px-3 text-[13px] font-medium text-text-muted transition hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary",
              collapsed && "justify-center px-0",
            )}
          >
            <Bot
              aria-hidden="true"
              className="size-4 shrink-0 text-accent-secondary group-hover:text-accent-primary"
            />
            {!collapsed && (
              <>
                <span className="truncate">AI Chat</span>
                <span className="size-1.5 rounded-full bg-amber-400" />
              </>
            )}
          </button>

          {/* Action Items */}
          <button
            type="button"
            onClick={() => {
              setHomeRightTab("actions");
              setRightPanelOpen(true);
              onClose?.();
              if (!isHome) router.push("/");
            }}
            title={collapsed ? "Action Items" : undefined}
            className={cn(
              "group flex h-10 w-full items-center gap-3 rounded-xl border border-transparent px-3 text-[13px] font-medium text-text-muted transition hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary",
              collapsed && "justify-center px-0",
            )}
          >
            <ListChecks
              aria-hidden="true"
              className="size-4 shrink-0 text-text-muted group-hover:text-text-primary"
            />
            {!collapsed && <span className="truncate">Action Items</span>}
          </button>

          {/* AI Models */}
          <Link
            href="/models/"
            onClick={onClose}
            aria-current={isModels ? "page" : undefined}
            title={collapsed ? "AI Models" : undefined}
            className={cn(
              "group flex h-10 items-center gap-3 rounded-xl border px-3 text-[13px] font-medium transition",
              isModels
                ? "border-accent-primary/20 bg-gradient-to-r from-accent-primary/16 to-accent-secondary/[0.06] text-text-primary shadow-[inset_3px_0_0_var(--brand-accent-primary)]"
                : "border-transparent text-text-muted hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary",
              collapsed && "justify-center px-0",
            )}
          >
            <Sparkles
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                isModels ? "text-accent-primary" : "text-text-muted group-hover:text-text-primary",
              )}
            />
            {!collapsed && <span className="truncate">AI Models</span>}
          </Link>
        </div>

        {/* Otter-style FOLDERS / CHANNELS Section */}
        {!collapsed && (
          <div className="mt-7">
            <div className="flex items-center justify-between px-2 pb-1.5">
              <button
                type="button"
                onClick={() => setFoldersExpanded((prev) => !prev)}
                className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted/65 transition hover:text-text-primary"
              >
                {foldersExpanded ? (
                  <ChevronDown className="size-3" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-3" aria-hidden="true" />
                )}
                <span>Folders</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setFoldersExpanded(true);
                  setCreatingFolder((prev) => !prev);
                }}
                aria-label="New folder"
                title="Create folder"
                className="flex size-5 items-center justify-center rounded text-text-muted transition hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary"
              >
                <FolderPlus className="size-3.5" aria-hidden="true" />
              </button>
            </div>

            {foldersExpanded && (
              <div className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => selectFolderAndGoHome("starred")}
                  className={cn(
                    "flex h-8 w-full items-center gap-2.5 rounded-xl px-3 text-xs font-medium transition",
                    isHome && activeFolderFilter === "starred"
                      ? "bg-accent-primary/12 text-accent-primary"
                      : "text-text-muted hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary",
                  )}
                >
                  <Star className="size-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                  <span className="truncate">Starred</span>
                </button>

                {folders.map((folder) => {
                  const selected = isHome && activeFolderFilter === folder.id;
                  return (
                    <div
                      key={folder.id}
                      className={cn(
                        "group flex h-8 items-center justify-between rounded-xl px-3 text-xs font-medium transition",
                        selected
                          ? "bg-accent-primary/12 text-accent-primary"
                          : "text-text-muted hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => selectFolderAndGoHome(folder.id)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <Hash className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                        <span className="truncate">{folder.name}</span>
                      </button>
                      {isTauri() && (
                        <button
                          type="button"
                          onClick={() => void handleDeleteFolder(folder)}
                          aria-label={`Delete folder ${folder.name}`}
                          className="opacity-0 transition group-hover:opacity-100 hover:text-recording-pulse"
                        >
                          <Trash2 className="size-3" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {creatingFolder && (
                  <div className="mt-1.5 space-y-1.5 px-1">
                    <input
                      value={folderDraft}
                      onChange={(e) => setFolderDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (isImeComposing(e)) return;
                          void handleCreateFolder();
                        } else if (e.key === "Escape") {
                          setCreatingFolder(false);
                        }
                      }}
                      placeholder="Folder name…"
                      aria-label="New folder name"
                      autoFocus
                      className="glass-input h-7 w-full px-2.5 text-xs text-text-primary outline-none"
                    />
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="xs" onClick={() => setCreatingFolder(false)}>
                        Cancel
                      </Button>
                      <Button variant="primary" size="xs" onClick={() => void handleCreateFolder()}>
                        Add
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Bottom Privacy / Local Vault Card */}
      <div className={cn("shrink-0 p-3", collapsed && "p-2")}>
        {collapsed ? (
          <div className="flex justify-center">
            <span
              title={`100% Local Vault · stored on ${deviceNoun}`}
              aria-label={`100% Local Vault. Stored on ${deviceNoun}.`}
              className="flex size-8 items-center justify-center text-accent-primary"
            >
              <ShieldCheck className="size-4" aria-hidden="true" />
            </span>
          </div>
        ) : (
          <div className="rounded-2xl border border-accent-primary/15 bg-gradient-to-br from-accent-primary/[0.09] to-accent-secondary/[0.04] p-3.5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 shrink-0 text-accent-primary" aria-hidden="true" />
              <p className="text-xs font-semibold text-text-primary">Private by design</p>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-text-muted">
              Your audio, transcripts, and AI stay on this device.
            </p>
            <Link
              href="/models/"
              onClick={onClose}
              className="mt-2.5 flex h-8 w-full items-center justify-center rounded-xl border border-accent-primary/35 bg-accent-primary/10 text-xs font-semibold text-accent-primary transition hover:bg-accent-primary/18"
            >
              Manage AI Models
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  const collapsed = useWorkspaceStore((state) => state.sidebarCollapsed);

  return (
    <aside
      aria-label="Workspace navigation"
      className={cn(
        "relative z-20 hidden h-full shrink-0 flex-col border-r border-[var(--glass-border)] bg-[var(--shell-sidebar)] transition-[width] duration-200 ease-out md:flex",
        collapsed ? "w-[72px]" : "w-[248px]",
      )}
    >
      <SidebarSheetContent />
    </aside>
  );
}
