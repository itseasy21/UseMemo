"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  FolderOpen,
  Hash,
  ListChecks,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  ShieldCheck,
  SunMoon,
  Users,
  LibraryBig,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { Popover } from "@/components/ui/Popover";
import { BrandMark, Wordmark } from "@/components/ui/Brand";
import { BRAND } from "@/generated/brand";
import { DEMO_MODEL_FOOTPRINT, DEMO_VAULT_PATH, MEETINGS, VAULT_STATS } from "@/lib/demo-data";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

const LIBRARY_ITEMS = [
  { href: "/", label: "All Memos", icon: LibraryBig, count: VAULT_STATS.memoCount },
  {
    href: "/#pending-actions",
    label: "Action Items Pending",
    icon: ListChecks,
    count: VAULT_STATS.pendingActions,
  },
  { href: "/#speakers", label: "By Speaker", icon: Users, count: VAULT_STATS.speakers },
  { href: "/#folders", label: "Folders", icon: FolderOpen, count: VAULT_STATS.folders },
  { href: "/#tags", label: "Tags", icon: Hash, count: VAULT_STATS.tags },
] as const;

function NavItem({
  href,
  label,
  icon: Icon,
  count,
  active,
  collapsed,
}: {
  href: string;
  label: string;
  icon: typeof LibraryBig;
  count: number;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? `${label} (${count})` : undefined}
      className={cn(
        "group flex h-8 items-center gap-2.5 rounded-brand px-2.5 text-[12px] transition-colors",
        active
          ? "bg-bg-elevated text-text-primary shadow-[inset_0_0_0_1px_var(--brand-border-subtle)]"
          : "text-text-muted hover:bg-bg-elevated/60 hover:text-text-primary",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          active ? "text-accent-primary" : "text-text-muted group-hover:text-text-muted",
        )}
      />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          <span
            className={cn(
              "tabular text-[9.5px]",
              active ? "text-text-muted" : "text-text-muted/70",
            )}
          >
            {count}
          </span>
        </>
      )}
    </a>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const collapsed = useWorkspaceStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const openPalette = useWorkspaceStore((state) => state.openPalette);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const toggleTheme = useWorkspaceStore((state) => state.toggleTheme);
  const theme = useWorkspaceStore((state) => state.theme);

  return (
    <aside
      aria-label="Workspace navigation"
      className={cn(
        "relative z-30 hidden h-dvh shrink-0 flex-col border-r border-border-subtle bg-[color-mix(in_oklch,var(--brand-bg-elevated)_38%,var(--brand-bg-primary))] transition-[width] duration-200 ease-out md:flex",
        collapsed ? "w-[72px]" : "w-[240px]",
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-border-subtle",
          collapsed ? "justify-center px-2" : "justify-between gap-2 px-3.5",
        )}
      >
        <Link href="/" aria-label={`${BRAND.productName} home`} className="min-w-0">
          <Wordmark collapsed={collapsed} />
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="flex size-7 shrink-0 items-center justify-center rounded-brand text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
          >
            <PanelLeftClose className="size-3.5" />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="mx-auto mt-2 flex size-7 items-center justify-center rounded-brand text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
        >
          <PanelLeftOpen className="size-3.5" />
        </button>
      )}

      <div className={cn("shrink-0", collapsed ? "px-2 pt-2" : "px-3 pt-3")}>
        {collapsed ? (
          <Popover
            label="Vault details"
            align="start"
            trigger={(props) => (
              <button
                {...props}
                aria-label="Vault details"
                className="mx-auto flex size-9 items-center justify-center rounded-brand border border-border-subtle bg-bg-primary/35 text-text-muted transition hover:border-text-muted/30 hover:text-text-primary"
              >
                <BrandMark className="size-5" />
              </button>
            )}
          >
            {() => <VaultDetails />}
          </Popover>
        ) : (
          <Popover
            label="Vault details"
            align="start"
            className="w-full"
            panelClassName="w-[248px]"
            trigger={(props) => (
              <button
                {...props}
                className="flex w-full items-center gap-2.5 rounded-brand border border-border-subtle bg-bg-primary/35 px-2.5 py-2 text-left transition hover:border-text-muted/30 hover:bg-bg-elevated/55"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-[6px] border border-border-subtle bg-bg-elevated text-text-muted">
                  <ShieldCheck className="size-3" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-medium text-text-primary">
                    Personal vault
                  </span>
                  <span className="block truncate text-[9px] text-text-muted">
                    org · local only
                  </span>
                </span>
                <ChevronDown className="size-3 shrink-0 text-text-muted" />
              </button>
            )}
          >
            {() => <VaultDetails />}
          </Popover>
        )}
      </div>

      <div className={cn("shrink-0", collapsed ? "px-2 pt-3" : "px-3 pt-3")}>
        {collapsed ? (
          <button
            type="button"
            onClick={openNewRecording}
            aria-label="New recording (Command N)"
            title="New recording · ⌘N"
            className="flex size-9 items-center justify-center rounded-brand bg-accent-primary text-bg-primary shadow-[inset_0_1px_0_oklch(1_0_0/0.16)] transition hover:brightness-110"
          >
            <Plus className="size-4" />
          </button>
        ) : (
          <Button
            variant="primary"
            size="md"
            className="w-full justify-between px-3"
            leading={<Plus className="size-3.5" />}
            trailing={
              <Kbd className="border-bg-primary/20 bg-bg-primary/15 text-bg-primary">⌘N</Kbd>
            }
            onClick={openNewRecording}
          >
            <span className="flex-1 text-left">New recording</span>
          </Button>
        )}
      </div>

      <div className={cn("shrink-0", collapsed ? "px-2 pt-2" : "px-3 pt-2")}>
        <button
          type="button"
          onClick={openPalette}
          aria-label="Search vault (Command K)"
          title="Search vault · ⌘K"
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-brand border border-border-subtle bg-bg-primary/35 text-left text-[11px] text-text-muted transition hover:border-text-muted/30 hover:text-text-primary",
            collapsed ? "justify-center px-0" : "px-2.5",
          )}
        >
          <Search className="size-3.5 shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1">Search</span>
              <Kbd>⌘K</Kbd>
            </>
          )}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-4" aria-label="Smart collections">
        {!collapsed && (
          <p className="px-2 pb-1.5 text-[8.5px] font-semibold uppercase tracking-[0.16em] text-text-muted/65">
            Library
          </p>
        )}
        <div className="space-y-0.5">
          {LIBRARY_ITEMS.map((item) => (
            <NavItem
              key={item.label}
              href={item.href}
              label={item.label}
              icon={item.icon}
              count={item.count}
              collapsed={collapsed}
              active={item.href === "/" ? pathname === "/" : false}
            />
          ))}
        </div>

        <div
          className={cn("mt-4 space-y-0.5 border-t border-border-subtle pt-3", collapsed && "mt-3")}
        >
          {!collapsed && (
            <p className="px-2 pb-1.5 text-[8.5px] font-semibold uppercase tracking-[0.16em] text-text-muted/65">
              Recent
            </p>
          )}
          {MEETINGS.slice(0, 3).map((meeting) => (
            <Link
              key={meeting.id}
              href={`/meeting/${meeting.id}/`}
              title={meeting.title}
              className={cn(
                "group flex items-center gap-2 rounded-brand py-1.5 text-text-muted transition hover:bg-bg-elevated/60 hover:text-text-primary",
                collapsed ? "justify-center px-0" : "px-2.5",
              )}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  meeting.id === "demo-q3-launch"
                    ? "bg-accent-primary"
                    : meeting.id === "demo-billing-arch"
                      ? "bg-accent-secondary"
                      : "bg-amber-500",
                )}
              />
              {!collapsed && (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-medium text-text-primary/90">
                    {meeting.title}
                  </span>
                  <span className="block truncate text-[9px] text-text-muted/75">
                    {meeting.dateLabel}
                  </span>
                </span>
              )}
            </Link>
          ))}
          {!collapsed && (
            <a
              href="/#recent"
              className="mt-0.5 flex items-center gap-1 px-2.5 py-1 text-[9.5px] text-text-muted/75 transition hover:text-text-primary"
            >
              All memos
              <ChevronRight className="size-2.5" />
            </a>
          )}
        </div>

        <div className={cn("mt-4 border-t border-border-subtle pt-2", collapsed && "mt-3")}>
          <NavItem
            href="/models/"
            label="Model Studio"
            icon={Cpu}
            count={5}
            collapsed={collapsed}
            active={Boolean(pathname?.startsWith("/models"))}
          />
        </div>
      </nav>

      <div className={cn("shrink-0 border-t border-border-subtle", collapsed ? "p-2" : "p-2.5")}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <a
              href="/models/"
              title={`LiteRT · Metal / XNNPACK · ${DEMO_MODEL_FOOTPRINT}`}
              aria-label={`LiteRT engine status, ${DEMO_MODEL_FOOTPRINT} on disk`}
              className="flex size-8 items-center justify-center rounded-brand border border-accent-primary/25 bg-accent-primary/[0.07] text-accent-primary"
            >
              <Cpu className="size-3.5" />
            </a>
            <span className="tabular text-[8px] text-text-muted">{DEMO_MODEL_FOOTPRINT}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                className="flex size-7 items-center justify-center rounded-brand text-text-muted hover:bg-bg-elevated hover:text-text-primary"
              >
                <SunMoon className="size-3.5" />
              </button>
              <span
                title="Offline mode enforced"
                aria-label="Offline mode enforced"
                className="flex size-7 items-center justify-center text-accent-primary"
              >
                <ShieldCheck className="size-3.5" />
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="rounded-brand border border-accent-primary/20 bg-accent-primary/[0.055] px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="size-3.5 text-accent-primary" />
                <span className="text-[10px] font-semibold text-text-primary">Offline Mode</span>
                <span className="ml-auto rounded-full border border-accent-primary/25 px-1.5 py-px text-[8px] font-semibold uppercase tracking-[0.08em] text-accent-primary">
                  Enforced
                </span>
              </div>
              <p className="mt-1 text-[9px] leading-4 text-text-muted">
                No egress since install · local inference only
              </p>
            </div>

            <a
              href="/models/"
              aria-label={`LiteRT engine: Metal and XNNPACK, ${DEMO_MODEL_FOOTPRINT} model footprint`}
              className="flex items-center gap-2 rounded-brand border border-border-subtle bg-bg-primary/30 px-2.5 py-2 transition hover:border-text-muted/30 hover:bg-bg-elevated/50"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-[5px] border border-accent-primary/20 bg-accent-primary/10 text-accent-primary">
                <Cpu className="size-3" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[9.5px] font-medium text-text-primary">
                  LiteRT · Metal + XNNPACK
                </span>
                <span className="block truncate text-[8.5px] text-text-muted">
                  {DEMO_MODEL_FOOTPRINT} pinned · 5 artifacts
                </span>
              </span>
              <span
                className="size-1.5 shrink-0 rounded-full bg-accent-primary"
                aria-hidden="true"
              />
            </a>

            <div className="flex items-center justify-between">
              <span className="truncate text-[8.5px] text-text-muted/60">{BRAND.licenseType}</span>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                className="flex size-6 items-center justify-center rounded-brand text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
              >
                <SunMoon className="size-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function VaultDetails() {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <BrandMark className="size-7" />
        <div>
          <p className="text-xs font-medium text-text-primary">Personal vault</p>
          <p className="text-[9px] text-text-muted">{BRAND.companyName}</p>
        </div>
      </div>
      <div className="space-y-1.5 border-t border-border-subtle pt-2.5">
        <p className="flex items-center gap-1.5 text-[9.5px] text-text-muted">
          <ShieldCheck className="size-3 text-accent-primary" />
          SQLite · WAL · encrypted at rest
        </p>
        <p className="break-all font-mono text-[8.5px] leading-4 text-text-muted/80">
          {DEMO_VAULT_PATH}
        </p>
        <p className="text-[8.5px] text-text-muted/70">
          {BRAND.licenseType} · {BRAND.storageDirName}
        </p>
      </div>
      <div className="flex gap-1.5">
        <a
          href="/models/"
          className="flex flex-1 items-center justify-center gap-1 rounded-brand border border-border-subtle px-2 py-1.5 text-[9.5px] text-text-muted transition hover:text-text-primary"
        >
          <Cpu className="size-3" />
          Models
        </a>
        <a
          href="/hud/"
          target="_blank"
          rel="noreferrer"
          className="flex flex-1 items-center justify-center gap-1 rounded-brand border border-border-subtle px-2 py-1.5 text-[9.5px] text-text-muted transition hover:text-text-primary"
        >
          <Mic className="size-3" />
          HUD
        </a>
      </div>
    </div>
  );
}
