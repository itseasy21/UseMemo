"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bookmark,
  Camera,
  Check,
  ChevronDown,
  FileCode2,
  ListChecks,
  Slash,
  Sparkles,
  SquareSlash,
  ToggleLeft,
} from "lucide-react";

import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import type { Meeting } from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import { htmlToMarkdown, markdownToHtml, noteLinesToHtml } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { useWorkspaceStore } from "@/stores/workspace";

type SlashState = {
  query: string;
  from: number;
  to: number;
  x: number;
  y: number;
};

type SlashCommand = {
  id: string;
  label: string;
  description: string;
  shortcut: string;
  icon: typeof ListChecks;
  insert: (time: string) => string;
};

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "decision",
    label: "Decision",
    description: "Callout a decision and require evidence",
    shortcut: "/decision",
    icon: ListChecks,
    insert: () => "<blockquote><p><strong>Decision</strong> </p></blockquote>",
  },
  {
    id: "todo",
    label: "To-do",
    description: "Assign an action with owner + deadline",
    shortcut: "/todo",
    icon: Check,
    insert: () =>
      "<p><strong>TODO</strong> <code>Unassigned</code> · <code>Not specified</code> · </p>",
  },
  {
    id: "shot",
    label: "Screenshot",
    description: "Pin the current slide at this timestamp",
    shortcut: "/shot",
    icon: Camera,
    insert: (time) => `<p><strong>Screenshot ${time}</strong> · </p>`,
  },
  {
    id: "bookmark",
    label: "Bookmark",
    description: "Mark a moment for synthesis",
    shortcut: "/bookmark",
    icon: Bookmark,
    insert: (time) => `<p><strong>Bookmark ${time}</strong> · </p>`,
  },
];

const EDITOR_CSS = `
  .um-notes .um-prosemirror {
    min-height: 100%;
    padding: 14px 28px 84px 86px;
    outline: none;
    font-size: 13px;
    line-height: 1.78;
    color: var(--brand-text-primary);
    caret-color: var(--brand-accent-primary);
  }
  .um-notes .um-prosemirror > * { position: relative; }
  .um-notes .um-prosemirror > [data-timestamp]::before {
    content: attr(data-timestamp);
    position: absolute;
    left: -64px;
    top: 0.28em;
    width: 48px;
    text-align: right;
    font-family: var(--brand-font-mono);
    font-size: 9.5px;
    line-height: 1.5;
    color: var(--brand-text-muted);
    opacity: .62;
    letter-spacing: .02em;
    pointer-events: none;
  }
  .um-notes .um-prosemirror h1,
  .um-notes .um-prosemirror h2,
  .um-notes .um-prosemirror h3 {
    margin: 20px 0 7px;
    font-weight: 600;
    letter-spacing: -0.025em;
    line-height: 1.28;
    color: var(--brand-text-primary);
  }
  .um-notes .um-prosemirror h2 { font-size: 18px; }
  .um-notes .um-prosemirror h3 { font-size: 15px; }
  .um-notes .um-prosemirror p { margin: 7px 0; }
  .um-notes .um-prosemirror > p:first-child { margin-top: 2px; }
  .um-notes .um-prosemirror strong { font-weight: 600; }
  .um-notes .um-prosemirror code {
    border: 1px solid var(--brand-border-subtle);
    border-radius: 4px;
    background: color-mix(in oklch, var(--brand-bg-elevated) 60%, transparent);
    padding: 1px 4px;
    font-family: var(--brand-font-mono);
    font-size: 10px;
    color: var(--brand-text-muted);
  }
  .um-notes .um-prosemirror blockquote {
    margin: 13px 0;
    border-left: 2px solid var(--brand-accent-primary);
    border-radius: 0 6px 6px 0;
    background: color-mix(in oklch, var(--brand-accent-primary) 7%, transparent);
    padding: 8px 12px 9px;
  }
  .um-notes .um-prosemirror blockquote p { margin: 0; }
  .um-notes .um-prosemirror blockquote p strong:first-child {
    display: inline-block;
    margin-right: 5px;
    font-family: var(--brand-font-mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: .12em;
    text-transform: uppercase;
    color: var(--brand-accent-primary);
  }
  .um-notes .um-prosemirror ul,
  .um-notes .um-prosemirror ol { margin: 8px 0; padding-left: 20px; }
  .um-notes .um-prosemirror li { margin: 3px 0; }
  .um-notes .um-prosemirror hr {
    margin: 20px 0;
    border: 0;
    border-top: 1px solid var(--brand-border-subtle);
  }
  .um-notes .um-prosemirror ::selection {
    background: color-mix(in oklch, var(--brand-accent-primary) 28%, transparent);
  }
  .um-notes .um-prosemirror > *:hover::before { opacity: 1; color: var(--brand-accent-primary); }
`;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function NotesEditor({ meeting }: { meeting: Meeting }) {
  const currentMs = usePlayerStore((state) => state.currentMs);
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const [mode, setMode] = useState<"rich" | "raw">("rich");
  const [raw, setRaw] = useState("");
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [wordCount, setWordCount] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const slashRef = useRef<SlashState | null>(null);
  const currentMsRef = useRef(currentMs);
  const noteTimesRef = useRef(meeting.notes.map((note) => note.startMs));

  currentMsRef.current = currentMs;
  slashRef.current = slash;

  const applyGutter = (instance: Editor) => {
    const blocks = Array.from(instance.view.dom.children) as HTMLElement[];
    blocks.forEach((block, index) => {
      if (!block.dataset.timestamp) {
        const noteTime = noteTimesRef.current[index];
        block.dataset.timestamp = formatTimestamp(noteTime ?? currentMsRef.current);
      }
    });
  };

  const detectSlash = (instance: Editor) => {
    if (!instance.isEditable || !instance.isFocused) {
      setSlash(null);
      return;
    }
    const selection = instance.state.selection;
    if (!selection.empty) {
      setSlash(null);
      return;
    }
    const { $from } = selection;
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
    const match = /(?:^|\s)\/([\w-]*)$/.exec(textBefore);
    if (!match) {
      setSlash(null);
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const coords = instance.view.coordsAtPos(selection.from);
    const nearBottom = coords.bottom - hostRect.top + 250 > host.clientHeight;
    const y = nearBottom
      ? coords.top - hostRect.top + host.scrollTop - 238
      : coords.bottom - hostRect.top + host.scrollTop + 5;
    const x = Math.min(
      Math.max(8, coords.left - hostRect.left),
      Math.max(8, host.clientWidth - 304),
    );
    const next: SlashState = {
      query: match[1],
      from: selection.from - match[1].length - 1,
      to: selection.from,
      x,
      y: Math.max(8, y),
    };
    setSlash(next);
    setSlashIndex(0);
  };

  const editor = useEditor(
    {
      extensions: [StarterKit],
      content: noteLinesToHtml(meeting.notes),
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: "um-prosemirror",
          spellcheck: "true",
        },
      },
      onCreate: ({ editor: instance }) => {
        applyGutter(instance);
        setWordCount(countWords(instance.getText()));
      },
      onUpdate: ({ editor: instance }) => {
        applyGutter(instance);
        detectSlash(instance);
        setWordCount(countWords(instance.getText()));
      },
      onSelectionUpdate: ({ editor: instance }) => {
        detectSlash(instance);
      },
    },
    [meeting.id],
  );

  const filteredCommands = SLASH_COMMANDS.filter((command) => {
    const query = slash?.query.toLowerCase() ?? "";
    return (
      command.id.startsWith(query) ||
      command.label.toLowerCase().includes(query) ||
      command.shortcut.includes(query)
    );
  });

  const executeSlash = (command: SlashCommand) => {
    const state = slashRef.current;
    if (!editor || !state) return;
    const time = formatTimestamp(usePlayerStore.getState().currentMs);
    editor
      .chain()
      .focus()
      .deleteRange({ from: state.from, to: state.to })
      .insertContent(command.insert(time))
      .run();
    setSlash(null);
    setSlashIndex(0);
    if (command.id === "shot") {
      pushToast(
        "Screenshot marker inserted",
        `${time} · attach it to the transcript or slide rail`,
      );
    }
    window.requestAnimationFrame(() => applyGutter(editor));
  };

  useEffect(() => {
    if (!slash) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setSlash(null);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setSlashIndex((index) =>
          filteredCommands.length === 0 ? 0 : (index + 1) % filteredCommands.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSlashIndex((index) =>
          filteredCommands.length === 0
            ? 0
            : (index - 1 + filteredCommands.length) % filteredCommands.length,
        );
        return;
      }
      if (event.key === "Enter") {
        const command = filteredCommands[slashIndex];
        if (command) {
          event.preventDefault();
          event.stopPropagation();
          executeSlash(command);
        }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [editor, filteredCommands, slash, slashIndex]);

  useEffect(() => {
    if (!slash) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (hostRef.current?.contains(event.target as Node)) {
        const target = event.target as HTMLElement;
        if (target.closest(".um-prosemirror")) return;
      }
      setSlash(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [slash]);

  const switchToRaw = () => {
    if (!editor) return;
    setRaw(htmlToMarkdown(editor.getHTML()));
    setMode("raw");
    setSlash(null);
  };

  const switchToRich = () => {
    if (!editor) return;
    editor.commands.setContent(markdownToHtml(raw), false);
    setMode("rich");
    window.requestAnimationFrame(() => applyGutter(editor));
  };

  const rawWords = countWords(raw);
  const liveStamp = formatTimestamp(currentMs);

  return (
    <section aria-label="Meeting notes" className="flex h-full min-h-0 flex-col bg-bg-primary">
      <div className="shrink-0 border-b border-border-subtle px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <FileCode2 className="size-3.5 text-text-muted" />
            <h2 className="text-[12px] font-semibold text-text-primary">Notes</h2>
            <span className="flex items-center gap-1 text-[9px] text-text-muted">
              <Check className="size-2.5 text-accent-primary" />
              stored in SQLite
            </span>
          </div>
          <span className="ml-auto flex items-center gap-1 rounded-full border border-accent-primary/20 bg-accent-primary/[0.06] px-2 py-0.5">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-recording-pulse opacity-50" />
              <span className="relative inline-flex size-1.5 rounded-full bg-recording-pulse" />
            </span>
            <span className="tabular text-[8.5px] font-medium text-text-primary">{liveStamp}</span>
            <span className="text-[8.5px] text-text-muted">live gutter</span>
          </span>
          <div
            className="flex h-6 items-center rounded-[6px] border border-border-subtle bg-bg-primary/40 p-0.5"
            role="group"
            aria-label="Note editor mode"
          >
            <button
              type="button"
              aria-pressed={mode === "rich"}
              onClick={() => mode === "raw" && switchToRich()}
              className={cn(
                "flex h-5 items-center gap-1 rounded-[4px] px-2 text-[9.5px] font-medium transition",
                mode === "rich"
                  ? "bg-bg-elevated text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-primary",
              )}
            >
              Rich
            </button>
            <button
              type="button"
              aria-pressed={mode === "raw"}
              onClick={() => mode === "rich" && switchToRaw()}
              className={cn(
                "flex h-5 items-center gap-1 rounded-[4px] px-2 text-[9.5px] font-medium transition",
                mode === "raw"
                  ? "bg-bg-elevated text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-primary",
              )}
            >
              Raw
              <span className="font-mono text-[8px] opacity-60">md</span>
            </button>
          </div>
        </div>
      </div>

      <div ref={hostRef} className="um-notes relative min-h-0 flex-1 overflow-y-auto">
        <style dangerouslySetInnerHTML={{ __html: EDITOR_CSS }} />
        {mode === "rich" ? (
          <EditorContent editor={editor} />
        ) : (
          <div className="flex min-h-full flex-col">
            <div className="flex items-center justify-between border-b border-border-subtle bg-bg-primary/30 px-3.5 py-1.5 text-[8.5px] text-text-muted">
              <span className="font-mono uppercase tracking-[0.12em]">Raw Markdown</span>
              <span>{raw.split("\n").length} lines · mono buffer</span>
            </div>
            <textarea
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              aria-label="Raw Markdown notes"
              spellCheck={false}
              className="tabular min-h-[480px] flex-1 resize-none bg-transparent px-4 py-3 text-[11px] leading-[1.8] text-text-primary outline-none placeholder:text-text-muted/50"
              placeholder="# Your notes&#10;&#10;- A timestamped thought…"
            />
          </div>
        )}

        {slash && mode === "rich" && (
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Insert a note block"
            className="panel absolute z-40 w-[296px] overflow-hidden p-1 shadow-[0_24px_60px_-20px_oklch(0_0_0/0.55)]"
            style={{ left: slash.x, top: slash.y }}
          >
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-[8.5px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                Note blocks
              </span>
              <span className="flex items-center gap-1 font-mono text-[8px] text-text-muted/70">
                <Slash className="size-2.5" />
                {slash.query || "…"}
              </span>
            </div>
            {filteredCommands.length === 0 ? (
              <p className="px-2.5 py-4 text-center text-[10px] text-text-muted">
                No block matches “{slash.query}”
              </p>
            ) : (
              filteredCommands.map((command, index) => {
                const Icon = command.icon;
                const selected = index === slashIndex;
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSlashIndex(index)}
                    onClick={() => executeSlash(command)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-[6px] px-2 py-2 text-left transition",
                      selected ? "bg-accent-primary/[0.09]" : "hover:bg-bg-elevated/70",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[5px] border",
                        selected
                          ? "border-accent-primary/25 bg-accent-primary/10 text-accent-primary"
                          : "border-border-subtle bg-bg-primary/45 text-text-muted",
                      )}
                    >
                      <Icon className="size-3" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-text-primary">
                          {command.label}
                        </span>
                        <span className="font-mono text-[8px] text-text-muted/70">
                          {command.shortcut}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[9px] leading-4 text-text-muted">
                        {command.description}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
            <div className="mt-1 flex items-center justify-between border-t border-border-subtle px-2 py-1 text-[8px] text-text-muted/60">
              <span>↑↓ select · ↵ insert</span>
              <span>esc close</span>
            </div>
          </div>
        )}
      </div>

      <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border-subtle px-3.5 text-[8.5px] text-text-muted">
        <span className="flex items-center gap-1.5">
          <SquareSlash className="size-2.5" />
          Type <Kbd className="h-4 text-[8px]">/</Kbd> for decision, todo, shot, bookmark
        </span>
        <span className="flex items-center gap-2">
          <span>{mode === "raw" ? rawWords : wordCount} words</span>
          <span className="text-border-subtle">·</span>
          <span className="flex items-center gap-1">
            <Sparkles className="size-2.5 text-accent-primary" />
            autosaved locally
          </span>
        </span>
      </footer>
    </section>
  );
}
