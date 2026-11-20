"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Captions,
  CornerDownLeft,
  Cpu,
  FileDown,
  FileJson,
  Mic,
  NotebookPen,
  Presentation,
  Search,
  ShieldCheck,
  StickyNote,
  SunMoon,
  X,
  type LucideIcon,
} from "lucide-react";

import { Kbd } from "@/components/ui/Kbd";
import { PRODUCT_NAME } from "@/generated/brand";
import {
  MEETINGS,
  PENDING_ACTIONS,
  meetingActionOwner,
  meetingHref,
  type Meeting,
} from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import {
  captureScreenshot,
  exportDiagnostics,
  listMeetings,
  recordingStatus,
  searchVaultHost,
  type MeetingRecord,
  type SearchHitRecord,
} from "@/lib/host";
import { isImeComposing } from "@/lib/ime";
import { modKeyPrefix, shiftModKeyPrefix } from "@/lib/platform";
import {
  CATEGORY_META,
  SEARCH_DOCS,
  makeSnippet,
  searchVault,
  splitHighlight,
  type SearchCategory,
  type SearchDoc,
} from "@/lib/search";
import { SEEK_HANDOFF_PREFIX } from "@/lib/session-keys";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

type PaletteItem = {
  id: string;
  label: string;
  subtitle: string;
  htmlSnippet?: string;
  icon: LucideIcon;
  hint?: string;
  category?: SearchCategory;
  timeLabel?: string;
  query?: string;
  onSelect: () => void;
};

type Section = {
  id: string;
  label: string;
  items: PaletteItem[];
};

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  return (
    <>
      {splitHighlight(text, query).map((part, index) =>
        part.match ? (
          <mark
            key={`${part.text}-${index}`}
            className="rounded-[2px] bg-accent-primary/20 px-px text-accent-primary"
          >
            {part.text}
          </mark>
        ) : (
          <span key={`${part.text}-${index}`}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Render sanitized FTS5 snippet HTML (`<mark>…</mark>` with all user characters
 * already HTML-escaped on the Rust side) into safe React spans/marks without
 * `dangerouslySetInnerHTML`.
 */
function SanitizedFtsSnippet({ snippet }: { snippet: string }) {
  const unescapeEntities = (raw: string) =>
    raw
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&");

  const parts = snippet.split(/(<mark>.*?<\/mark>)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, idx) => {
        if (part.startsWith("<mark>") && part.endsWith("</mark>")) {
          return (
            <mark
              key={idx}
              className="rounded-[2px] bg-accent-primary/20 px-px text-accent-primary"
            >
              {unescapeEntities(part.slice(6, -7))}
            </mark>
          );
        }
        return <span key={idx}>{unescapeEntities(part)}</span>;
      })}
    </>
  );
}

function exportDemoVaultMarkdown() {
  const lines: string[] = [
    "---",
    `product: "${PRODUCT_NAME}"`,
    "exported_by: local-first vault",
    `exported_at: "${new Date().toISOString()}"`,
    "---",
    "",
  ];

  for (const meeting of MEETINGS) {
    lines.push(`# ${meeting.title}`, "");
    lines.push(`> ${meeting.summary.headline}`, "");
    lines.push(`- Date: ${meeting.dateLabel}`);
    lines.push(`- Duration: ${formatTimestamp(meeting.durationMs)}`);
    lines.push(`- Participants: ${meeting.participants.map((person) => person.name).join(", ")}`);
    lines.push(`- Folder: ${meeting.folder}`, "");
    lines.push("## Summary", "");
    meeting.summary.paragraphs.forEach((paragraph) => lines.push(paragraph.text, ""));
    lines.push("## Decisions", "");
    meeting.decisions.forEach((decision) => lines.push(`- ${decision.text}`));
    lines.push("", "## Action items", "");
    meeting.actions.forEach((action) => {
      const owner = meetingActionOwner(meeting, action)?.name ?? "Unassigned";
      const deadline = action.deadline ?? "Not specified";
      lines.push(
        `- [${action.done ? "x" : " "}] ${action.task} — owner: ${owner} — due: ${deadline}`,
      );
    });
    lines.push("", "---", "");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${PRODUCT_NAME.toLowerCase().replace(/\s+/g, "-")}-vault-${new Date()
    .toISOString()
    .slice(0, 10)}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function docIcon(category: SearchCategory): LucideIcon {
  switch (category) {
    case "memo":
      return NotebookPen;
    case "transcript":
      return Captions;
    case "note":
      return StickyNote;
    case "slide":
      return Presentation;
  }
}

export function CommandPalette() {
  const router = useRouter();
  const open = useWorkspaceStore((state) => state.paletteOpen);
  const closePalette = useWorkspaceStore((state) => state.closePalette);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const toggleTheme = useWorkspaceStore((state) => state.toggleTheme);
  const theme = useWorkspaceStore((state) => state.theme);

  const [native, setNative] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentMeetings, setRecentMeetings] = useState<MeetingRecord[]>([]);
  const [hostHits, setHostHits] = useState<SearchHitRecord[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const listId = useId();
  const modKey = modKeyPrefix();
  const shiftModKey = shiftModKeyPrefix();

  useEffect(() => setNative(isTauri()), []);

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    if (isTauri()) {
      void listMeetings().then((rows) => {
        if (rows) setRecentMeetings(rows.slice(0, 8));
      });
    }
    return () => {
      window.cancelAnimationFrame(raf);
      previousFocus.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    setQuery("");
    setHostHits([]);
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
    if (!open || !native) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setHostHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchVaultHost(trimmed, { limit: 24 }).then((hits) => {
        if (!cancelled) setHostHits(hits ?? []);
      });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [native, open, query]);

  const navigateTo = (path: string) => {
    closePalette();
    router.push(path);
  };

  const commands = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: "cmd-record",
        label: "Start Recording",
        subtitle: "New local capture · mic + system audio",
        icon: Mic,
        hint: `${modKey}N`,
        onSelect: () => openNewRecording(),
      },
      {
        id: "cmd-snap",
        label: "Take Screenshot",
        subtitle: "Manual snap · dHash dedupe · stored in vault",
        icon: Camera,
        hint: `${shiftModKey}S`,
        onSelect: () => {
          closePalette();
          if (!native) {
            pushToast(
              "Screenshot captured",
              "Manual snap · stored as WebP · perceptual dedupe passed",
              "success",
            );
            return;
          }
          void (async () => {
            try {
              const snap = await recordingStatus();
              const targetId = snap?.meetingId ?? recentMeetings[0]?.id;
              if (!targetId) {
                pushToast(
                  "No meeting open",
                  "Start a recording first to capture a slide.",
                  "accent",
                );
                return;
              }
              const result = await captureScreenshot(targetId);
              if (result?.deduplicated) {
                pushToast("Slide unchanged", result.reason, "default");
              } else {
                pushToast("Screenshot captured", "Saved locally as WebP.", "success");
              }
            } catch (err) {
              pushToast("Screenshot failed", formatHostError(err), "danger");
            }
          })();
        },
      },
      {
        id: "cmd-model",
        label: "Open AI Models",
        subtitle: "On-device transcription and synthesis models",
        icon: Cpu,
        onSelect: () => navigateTo("/models/"),
      },
      {
        id: "cmd-theme",
        label: `Switch to ${theme === "dark" ? "Light" : "Dark"} Theme`,
        subtitle: "Change how the app looks across windows",
        icon: SunMoon,
        onSelect: () => {
          toggleTheme();
          closePalette();
        },
      },
    ];

    if (native) {
      items.push({
        id: "cmd-diagnostics",
        label: "Export Diagnostics Bundle",
        subtitle: "Sanitized hardware, model, & log JSON (zero meeting content)",
        icon: FileJson,
        onSelect: () => {
          closePalette();
          void exportDiagnostics()
            .then((outcome) => {
              if (outcome) {
                pushToast(
                  "Diagnostics exported",
                  `${outcome.path} (${outcome.logLines} log lines)`,
                  "success",
                );
              }
            })
            .catch((err) => {
              pushToast("Could not export diagnostics", formatHostError(err), "danger");
            });
        },
      });
    } else {
      items.push({
        id: "cmd-export",
        label: "Export Demo Vault to Markdown",
        subtitle: `${MEETINGS.length} demos · frontmatter + citations`,
        icon: FileDown,
        onSelect: () => {
          closePalette();
          exportDemoVaultMarkdown();
          pushToast(
            "Vault exported",
            "Markdown bundle written locally · no network egress",
            "success",
          );
        },
      });
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    modKey,
    native,
    openNewRecording,
    pushToast,
    recentMeetings,
    shiftModKey,
    theme,
    toggleTheme,
  ]);

  const toDemoDocItem = (doc: SearchDoc, q: string): PaletteItem => ({
    id: doc.id,
    label: doc.title,
    subtitle: q ? makeSnippet(doc.snippet, q) : `${doc.meetingTitle} · ${doc.snippet}`,
    icon: docIcon(doc.category),
    category: doc.category,
    timeLabel: doc.category === "memo" ? undefined : formatTimestamp(doc.startMs),
    query: q,
    onSelect: () => {
      try {
        if (doc.category !== "memo") {
          window.sessionStorage.setItem(
            `${SEEK_HANDOFF_PREFIX}${doc.meetingId}`,
            String(doc.startMs),
          );
        }
      } catch {
        // Ignore storage restrictions.
      }
      navigateTo(meetingHref(doc.meetingId));
    },
  });

  const sections = useMemo<Section[]>(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matchedCommands = commands
      .filter((command) => {
        if (tokens.length === 0) return true;
        const haystack = `${command.label} ${command.subtitle}`.toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      })
      .map((command) => ({ ...command, query, category: undefined }));

    if (native) {
      if (!query.trim()) {
        const recents: PaletteItem[] = recentMeetings.map((m) => ({
          id: `recent-${m.id}`,
          label: m.title,
          subtitle: `${m.status} · ${formatTimestamp(m.durationMs)}`,
          icon: NotebookPen,
          category: "memo",
          timeLabel: formatTimestamp(m.durationMs),
          onSelect: () => navigateTo(meetingHref(m.id)),
        }));
        return [
          { id: "commands", label: "Commands", items: matchedCommands },
          { id: "recent", label: "Recent memos", items: recents },
        ].filter((section) => section.items.length > 0);
      }

      const ftsItems: PaletteItem[] = hostHits.map((hit) => ({
        id: `fts-${hit.meetingId}`,
        label: hit.title,
        subtitle: hit.snippet,
        htmlSnippet: hit.snippet,
        icon: NotebookPen,
        category: "memo",
        query,
        onSelect: () => navigateTo(meetingHref(hit.meetingId)),
      }));

      return [
        { id: "commands", label: "Commands", items: matchedCommands },
        { id: "vault-hits", label: "SQLite FTS5 Matches", items: ftsItems },
      ].filter((section) => section.items.length > 0);
    }

    if (!query.trim()) {
      const recent = SEARCH_DOCS.filter((doc) => doc.category === "memo").map((doc) =>
        toDemoDocItem(doc, ""),
      );
      return [
        { id: "commands", label: "Commands", items: matchedCommands },
        { id: "recent", label: "Recent memos", items: recent },
      ].filter((section) => section.items.length > 0);
    }

    const docs = searchVault(query, 26);
    const grouped = new Map<SearchCategory, PaletteItem[]>();
    for (const doc of docs) {
      const items = grouped.get(doc.category) ?? [];
      items.push(toDemoDocItem(doc, query));
      grouped.set(doc.category, items);
    }
    return [
      { id: "commands", label: "Commands", items: matchedCommands },
      ...(["memo", "transcript", "note", "slide"] as SearchCategory[])
        .map((category) => ({
          id: category,
          label: CATEGORY_META[category].label,
          items: grouped.get(category) ?? [],
        }))
        .filter((section) => section.items.length > 0),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands, hostHits, native, query, recentMeetings]);

  const flatItems = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const safeIndex = flatItems.length === 0 ? -1 : Math.min(activeIndex, flatItems.length - 1);
  const activeItem = safeIndex >= 0 ? flatItems[safeIndex] : null;

  useEffect(() => {
    if (!open || !activeItem) return;
    const element = document.getElementById(`palette-item-${activeItem.id}`);
    element?.scrollIntoView({ block: "nearest" });
  }, [activeItem, open]);

  if (!open) return null;

  const activate = (item: PaletteItem) => {
    item.onSelect();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (flatItems.length > 0) setActiveIndex((safeIndex + 1) % flatItems.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (flatItems.length > 0)
        setActiveIndex((safeIndex - 1 + flatItems.length) % flatItems.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeItem) activate(activeItem);
      return;
    }
    if (event.key === "Tab") {
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    }
  };

  let runningIndex = -1;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-start justify-center overflow-y-auto bg-[oklch(0.06_0.01_255/0.58)] p-4 pt-[13vh] backdrop-blur-[3px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass w-full max-w-[680px] overflow-hidden rounded-[calc(var(--radius-brand)+6px)] shadow-[0_40px_120px_-24px_oklch(0_0_0/0.75)]"
      >
        <h2 id={titleId} className="sr-only">
          Search the local vault and run commands
        </h2>
        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
          <Search className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memos, notes, transcripts, slides, or type a command…"
            aria-label="Search the local vault"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeItem ? `palette-item-${activeItem.id}` : undefined}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[15px] font-medium text-text-primary outline-none placeholder:text-text-muted/80"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="rounded p-1 text-text-muted hover:text-text-primary"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : (
            <Kbd>esc</Kbd>
          )}
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label="Vault search results"
          className="max-h-[min(58vh,480px)] overflow-y-auto overscroll-contain p-2"
        >
          {flatItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
              <span className="mb-3 flex size-10 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/40 text-text-muted">
                <ShieldCheck className="size-4" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium text-text-primary">No local matches</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-text-muted">
                SQLite FTS5 searched your local vault. Nothing left this device.
              </p>
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.id} className="mb-1.5 last:mb-0">
                <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted/80">
                  {section.label}
                  <span className="ml-1.5 font-mono text-[10px] tracking-normal text-text-muted/65">
                    {section.items.length}
                  </span>
                </p>
                {section.items.map((item) => {
                  runningIndex += 1;
                  const index = runningIndex;
                  const Icon = item.icon;
                  const selected = safeIndex === index;
                  return (
                    <button
                      type="button"
                      id={`palette-item-${item.id}`}
                      key={item.id}
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => activate(item)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-brand px-2.5 py-2 text-left transition-colors",
                        selected ? "bg-accent-primary/[0.10]" : "hover:bg-bg-elevated/70",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-[7px] border",
                          selected
                            ? "border-accent-primary/25 bg-accent-primary/10 text-accent-primary"
                            : "border-border-subtle bg-bg-primary/40 text-text-muted",
                        )}
                      >
                        <Icon className="size-3.5" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-text-primary">
                            <Highlighted text={item.label} query={item.query ?? ""} />
                          </span>
                          {item.category && (
                            <span className="shrink-0 rounded-full border border-border-subtle px-1.5 py-px text-[9.5px] uppercase tracking-[0.08em] text-text-muted">
                              {CATEGORY_META[item.category].short}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] leading-4 text-text-muted">
                          {item.htmlSnippet ? (
                            <SanitizedFtsSnippet snippet={item.htmlSnippet} />
                          ) : (
                            <Highlighted text={item.subtitle} query={item.query ?? ""} />
                          )}
                        </span>
                      </span>
                      {item.timeLabel && (
                        <span className="tabular shrink-0 text-[10.5px] text-text-muted">
                          {item.timeLabel}
                        </span>
                      )}
                      {item.hint && <Kbd>{item.hint}</Kbd>}
                      {selected && (
                        <CornerDownLeft
                          className="size-3.5 shrink-0 text-text-muted/70"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle bg-bg-primary/30 px-4 py-2">
          <div className="flex items-center gap-3 text-[10.5px] text-text-muted">
            <span className="flex items-center gap-1">
              <ArrowUp className="size-3" aria-hidden="true" />
              <ArrowDown className="size-3" aria-hidden="true" />
              navigate
            </span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="size-3" aria-hidden="true" />
              open
            </span>
            <span className="hidden items-center gap-1 sm:flex">
              <Kbd>esc</Kbd>
              close
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
            <span className="size-1.5 rounded-full bg-accent-primary" />
            SQLite FTS5
            {!native && (
              <>
                <span className="text-border-subtle">·</span>
                {SEARCH_DOCS.length + PENDING_ACTIONS.length} rows
              </>
            )}
            <span className="text-border-subtle">·</span>
            offline
          </div>
        </div>
      </div>
    </div>
  );
}

export function findMeetingForDoc(doc: SearchDoc): Meeting | undefined {
  return MEETINGS.find((meeting) => meeting.id === doc.meetingId);
}
