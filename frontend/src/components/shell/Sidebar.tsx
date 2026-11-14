"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AudioLines,
  House,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  SunMoon,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { Wordmark } from "@/components/ui/Brand";
import { BRAND } from "@/generated/brand";
import { MEETINGS, VAULT_STATS } from "@/lib/demo-data";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

type NavEntry = {
  href: string;
  label: string;
  icon: LucideIcon;
  count?: number;
};

const NAV_ITEMS: NavEntry[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/#recent", label: "Meetings", icon: AudioLines },
  {
    href: "/#next-steps",
    label: "Next steps",
    icon: ListChecks,
    count: VAULT_STATS.pendingActions,
  },
  { href: "/models/", label: "AI models", icon: Sparkles },
];

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
  icon: LucideIcon;
  count?: number;
  active: boolean;
  collapsed: boolean;
}) {
  const content = (
    <>
      <Icon
        className={cn(
          "size-4 shrink-0",
          active ? "text-accent-primary" : "text-text-muted group-hover:text-text-primary",
        )}
      />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          {count ? (
            <span
              className={cn(
                "tabular text-[11px]",
                active ? "text-accent-primary" : "text-text-muted/70",
              )}
            >
              {count}
            </span>
          ) : null}
        </>
      )}
    </>
  );

  const className = cn(
    "group flex h-9 items-center gap-3 rounded-brand px-3 text-[13px] transition-colors",
    active
      ? "bg-bg-elevated text-text-primary shadow-[inset_0_0_0_1px_var(--brand-border-subtle)]"
      : "text-text-muted hover:bg-bg-elevated/60 hover:text-text-primary",
    collapsed && "justify-center px-0",
  );
  const title = collapsed ? `${label}${count ? ` (${count})` : ""}` : undefined;

  if (href.includes("#")) {
    return (
      <a href={href} aria-current={active ? "page" : undefined} title={title} className={className}>
        {content}
      </a>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={title}
      className={className}
    >
      {content}
    </Link>
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
  const themeLabel = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href === "/models/") return Boolean(pathname?.startsWith("/models"));
    return false;
  };

  return (
    <aside
      aria-label="Workspace navigation"
      className={cn(
        "relative z-30 hidden h-dvh shrink-0 flex-col border-r border-border-subtle bg-[color-mix(in_oklch,var(--brand-bg-elevated)_38%,var(--brand-bg-primary))] transition-[width] duration-200 ease-out md:flex",
        collapsed ? "w-[72px]" : "w-[248px]",
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-border-subtle",
          collapsed ? "justify-center px-2" : "justify-between gap-2 px-3.5",
        )}
      >
        <Link href="/" aria-label={`${BRAND.productName} home`} className="min-w-0">
          <Wordmark collapsed={collapsed} showTagline={false} />
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

      <div className={cn("shrink-0", collapsed ? "px-2 pt-3" : "px-3 pt-3")}>
        {collapsed ? (
          <button
            type="button"
            onClick={openNewRecording}
            aria-label="New recording (Command N)"
            title="New recording · ⌘N"
            className="flex size-10 items-center justify-center rounded-brand bg-accent-primary text-bg-primary shadow-[inset_0_1px_0_oklch(1_0_0/0.16)] transition hover:brightness-110"
          >
            <Plus className="size-4" />
          </button>
        ) : (
          <Button
            variant="primary"
            size="md"
            className="h-10 w-full justify-between px-3"
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
          aria-label="Search memos (Command K)"
          title="Search memos · ⌘K"
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-brand border border-border-subtle bg-bg-primary/35 text-left text-[12.5px] text-text-muted transition hover:border-text-muted/30 hover:text-text-primary",
            collapsed ? "justify-center px-0" : "px-3",
          )}
        >
          <Search className="size-4 shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1">Search memos</span>
              <Kbd>⌘K</Kbd>
            </>
          )}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-5" aria-label="Main">
        {!collapsed && (
          <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted/65">
            Menu
          </p>
        )}
        <div className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavItem
              key={item.label}
              href={item.href}
              label={item.label}
              icon={item.icon}
              count={item.count}
              collapsed={collapsed}
              active={isActive(item.href)}
            />
          ))}
        </div>

        {!collapsed && (
          <div className="mt-6 border-t border-border-subtle pt-4">
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted/65">
              Recent
            </p>
            <div className="space-y-0.5">
              {MEETINGS.slice(0, 3).map((meeting) => (
                <Link
                  key={meeting.id}
                  href={`/meeting/${meeting.id}/`}
                  title={meeting.title}
                  className="group flex items-center gap-2.5 rounded-brand px-3 py-2 transition hover:bg-bg-elevated/60"
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
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-text-primary/90 transition group-hover:text-text-primary">
                      {meeting.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-text-muted">
                      {meeting.dateLabel}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className={cn("shrink-0 border-t border-border-subtle", collapsed ? "p-2" : "p-2.5")}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <span
              title="Private by design · stored on this Mac"
              aria-label="Private by design. Stored on this Mac."
              className="flex size-8 items-center justify-center text-accent-primary"
            >
              <ShieldCheck className="size-4" />
            </span>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={themeLabel}
              title={themeLabel}
              className="flex size-7 items-center justify-center rounded-brand text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
            >
              <SunMoon className="size-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 rounded-brand border border-border-subtle bg-bg-primary/30 px-3 py-2.5">
            <ShieldCheck className="size-4 shrink-0 text-accent-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] font-medium text-text-primary">Private by design</p>
              <p className="mt-0.5 text-[10.5px] leading-4 text-text-muted">
                Stored on this Mac. Nothing uploaded.
              </p>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={themeLabel}
              title={themeLabel}
              className="flex size-7 shrink-0 items-center justify-center rounded-brand text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
            >
              <SunMoon className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
