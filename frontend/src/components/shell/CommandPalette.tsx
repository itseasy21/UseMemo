"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Captions,
  CornerDownLeft,
  Cpu,
  FileDown,
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
import { MEETINGS, PENDING_ACTIONS, meetingActionOwner, type Meeting } from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import { SEEK_HANDOFF_PREFIX } from "@/lib/session-keys";
import { isTauri } from "@/lib/tauri";
import {
  CATEGORY_META,
  SEARCH_DOCS,
  makeSnippet,
  searchVault,
  splitHighlight,
  type SearchCategory,
  type SearchDoc,
} from "@/lib/search";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

type PaletteItem = {
  id: string;
  label: string;
  subtitle: string;
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

function navigate(path: string) {
  window.location.assign(path);
}

function exportVaultMarkdown() {
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
    lines.push("", "## Notes", "");
    meeting.notes.forEach((note) => {
      lines.push(`- **${formatTimestamp(note.startMs)}** ${note.text}`);
    });
    lines.push("", "## Transcript", "");
    meeting.transcripts.forEach((segment) => {
      const speaker =
        meeting.participants.find((person) => person.id === segment.speakerId)?.name ?? "Speaker";
      lines.push(`**${formatTimestamp(segment.startMs)} · ${speaker}** — ${segment.confirmedText}`);
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

function openSearchDoc(doc: SearchDoc) {
  try {
    if (doc.category !== "memo") {
      window.sessionStorage.setItem(`${SEEK_HANDOFF_PREFIX}${doc.meetingId}`, String(doc.startMs));
    }
  } catch {
    // Session handoff is a progressive enhancement.
  }
  navigate(`/meeting/${doc.meetingId}/`);
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
  const open = useWorkspaceStore((state) => state.paletteOpen);
  const closePalette = useWorkspaceStore((state) => state.closePalette);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const toggleTheme = useWorkspaceStore((state) => state.toggleTheme);
  const theme = useWorkspaceStore((state) => state.theme);

  const [native, setNative] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const listId = useId();

  useEffect(() => setNative(isTauri()), []);

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(raf);
      previousFocus.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    setQuery("");
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const commands = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: "cmd-record",
        label: "Start Recording",
        subtitle: "New local capture · mic + system audio",
        icon: Mic,
        hint: "⌘N",
        onSelect: () => openNewRecording(),
      },
      {
        id: "cmd-model",
        label: "Open AI Models",
        subtitle: "On-device transcription and language models",
        icon: Cpu,
        onSelect: () => {
          closePalette();
          navigate("/models/");
        },
      },
      {
        id: "cmd-theme",
        label: `Switch to ${theme === "dark" ? "Light" : "Dark"} Theme`,
        subtitle: "Change how the app looks",
        icon: SunMoon,
        onSelect: () => {
          toggleTheme();
          closePalette();
        },
      },
    ];

    if (!native) {
      items.splice(1, 0, {
        id: "cmd-snap",
        label: "Take Screenshot",
        subtitle: "Manual snap · dHash dedupe · stored in vault",
        icon: Camera,
        hint: "⇧⌘S",
        onSelect: () => {
          closePalette();
          pushToast(
            "Screenshot captured",
            "Manual snap · stored as WebP · perceptual dedupe passed",
            "success",
          );
        },
      });
      items.splice(items.length - 1, 0, {
        id: "cmd-export",
        label: "Export Vault to Markdown",
        subtitle: `${MEETINGS.length} demos · frontmatter + relative assets`,
        icon: FileDown,
        onSelect: () => {
          closePalette();
          exportVaultMarkdown();
          pushToast(
            "Vault exported",
            "Markdown bundle written locally · no network egress",
            "success",
          );
        },
      });
    }

    return items;
  }, [closePalette, native, openNewRecording, pushToast, theme, toggleTheme]);

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
      return [{ id: "commands", label: "Actions", items: matchedCommands }].filter(
        (section) => section.items.length > 0,
      );
    }

    if (!query.trim()) {
      const recent = SEARCH_DOCS.filter((doc) => doc.category === "memo").map((doc) =>
        toDocItem(doc, ""),
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
      items.push(toDocItem(doc, query));
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
  }, [commands, native, query]);

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
          {native ? "Command menu" : "Search the local vault"}
        </h2>
        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
          <Search className="size-4 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={native ? "Type a command…" : "Search notes, transcripts, slides…"}
            aria-label={native ? "Command menu" : "Search the local vault"}
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
              <X className="size-3.5" />
            </button>
          ) : (
            <Kbd>esc</Kbd>
          )}
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label={native ? "Actions" : "Vault search results"}
          className="max-h-[min(58vh,480px)] overflow-y-auto overscroll-contain p-2"
        >
          {flatItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
              <span className="mb-3 flex size-10 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/40 text-text-muted">
                <ShieldCheck className="size-4" />
              </span>
              <p className="text-sm font-medium text-text-primary">
                {native ? "No matching actions" : "No local matches"}
              </p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-text-muted">
                {native
                  ? "Try a different command."
                  : `The FTS5 index searched ${SEARCH_DOCS.length} demo passages. Nothing left the machine.`}
              </p>
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.id} className="mb-1.5 last:mb-0">
                <p className="px-2.5 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-text-muted/80">
                  {section.label}
                  <span className="ml-1.5 font-mono text-[8px] tracking-normal text-text-muted/60">
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
                        <Icon className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[12.5px] font-medium text-text-primary">
                            <Highlighted text={item.label} query={item.query ?? ""} />
                          </span>
                          {item.category && (
                            <span className="shrink-0 rounded-full border border-border-subtle px-1.5 py-px text-[8px] uppercase tracking-[0.08em] text-text-muted">
                              {CATEGORY_META[item.category].short}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[10.5px] leading-4 text-text-muted">
                          <Highlighted text={item.subtitle} query={item.query ?? ""} />
                        </span>
                      </span>
                      {item.timeLabel && (
                        <span className="tabular shrink-0 text-[10px] text-text-muted">
                          {item.timeLabel}
                        </span>
                      )}
                      {item.hint && <Kbd>{item.hint}</Kbd>}
                      {selected && (
                        <CornerDownLeft className="size-3 shrink-0 text-text-muted/70" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle bg-bg-primary/30 px-4 py-2">
          <div className="flex items-center gap-3 text-[9.5px] text-text-muted">
            <span className="flex items-center gap-1">
              <ArrowUp className="size-2.5" />
              <ArrowDown className="size-2.5" />
              navigate
            </span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="size-2.5" />
              open
            </span>
            <span className="hidden items-center gap-1 sm:flex">
              <Kbd>esc</Kbd>
              close
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[9.5px] text-text-muted">
            <span className="size-1.5 rounded-full bg-accent-primary" />
            {native ? "Local actions" : "SQLite FTS5"}
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

function toDocItem(doc: SearchDoc, query: string): PaletteItem {
  return {
    id: doc.id,
    label: doc.title,
    subtitle: query ? makeSnippet(doc.snippet, query) : `${doc.meetingTitle} · ${doc.snippet}`,
    icon: docIcon(doc.category),
    category: doc.category,
    timeLabel: doc.category === "memo" ? undefined : formatTimestamp(doc.startMs),
    query,
    onSelect: () => {
      useWorkspaceStore.getState().closePalette();
      openSearchDoc(doc);
    },
  };
}

export function findMeetingForDoc(doc: SearchDoc): Meeting | undefined {
  return MEETINGS.find((meeting) => meeting.id === doc.meetingId);
}
