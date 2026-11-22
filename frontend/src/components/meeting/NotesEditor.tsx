"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlertCircle,
  Bookmark,
  Camera,
  Check,
  FileCode2,
  ListChecks,
  Loader2,
  Plus,
  Slash,
} from "lucide-react";

import { Kbd } from "@/components/ui/Kbd";
import type { Meeting } from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import { captureScreenshot, saveNotes, type SaveNotesInput } from "@/lib/host";
import { isImeComposing } from "@/lib/ime";
import {
  htmlToMarkdown,
  markdownToHtml,
  noteLinesToHtml,
  serializeRawMarkdownToNotePayload,
  serializeRichEditorToNotePayload,
} from "@/lib/markdown";
import { formatHostError, isTauri } from "@/lib/tauri";
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
    label: "Action item",
    description: "Assign a task with owner + deadline",
    shortcut: "/todo",
    icon: Check,
    insert: () =>
      "<p><strong>TODO</strong> <code>Unassigned</code> · <code>Not specified</code> · </p>",
  },
  {
    id: "shot",
    label: "Capture slide",
    description: "Snap & pin the current screen at this timestamp",
    shortcut: "/shot",
    icon: Camera,
    insert: (time) => `<p><strong>Screenshot ${time}</strong> · </p>`,
  },
  {
    id: "bookmark",
    label: "Bookmark",
    description: "Mark a key moment for AI synthesis",
    shortcut: "/bookmark",
    icon: Bookmark,
    insert: (time) => `<p><strong>Bookmark ${time}</strong> · </p>`,
  },
];

const EDITOR_CSS = `
  .um-notes .um-prosemirror {
    min-height: 100%;
    padding: 18px 28px 84px 78px;
    outline: none;
    font-size: 14px;
    line-height: 1.78;
    color: var(--brand-text-primary);
    caret-color: var(--brand-accent-primary);
  }
  .um-notes .um-prosemirror > * { position: relative; }
  .um-notes .um-prosemirror > [data-timestamp]::before {
    content: attr(data-timestamp);
    position: absolute;
    left: -58px;
    top: 0.28em;
    width: 44px;
    text-align: right;
    font-family: var(--brand-font-mono);
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--brand-text-muted);
    opacity: .55;
    letter-spacing: .01em;
    pointer-events: none;
    transition: opacity 0.15s, color 0.15s;
  }
  .um-notes .um-prosemirror h1,
  .um-notes .um-prosemirror h2,
  .um-notes .um-prosemirror h3 {
    margin: 20px 0 8px;
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
    border: 1px solid var(--glass-border-strong);
    border-radius: 6px;
    background: color-mix(in oklab, var(--brand-bg-elevated) 60%, transparent);
    padding: 1.5px 5px;
    font-family: var(--brand-font-mono);
    font-size: 11px;
    color: var(--brand-text-muted);
  }
  .um-notes .um-prosemirror pre {
    margin: 12px 0;
    overflow-x: auto;
    border: 1px solid var(--glass-border);
    border-radius: 10px;
    background: color-mix(in oklab, var(--brand-bg-elevated) 75%, transparent);
    padding: 10px 12px;
    font-family: var(--brand-font-mono);
    font-size: 11.5px;
    line-height: 1.6;
  }
  .um-notes .um-prosemirror pre code {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--brand-text-primary);
  }
  .um-notes .um-prosemirror blockquote {
    margin: 13px 0;
    border-left: 3px solid var(--brand-accent-primary);
    border-radius: 0 10px 10px 0;
    background: color-mix(in oklab, var(--brand-accent-primary) 8%, transparent);
    padding: 9px 14px 10px;
  }
  .um-notes .um-prosemirror blockquote p { margin: 0; }
  .um-notes .um-prosemirror blockquote p strong:first-child {
    display: inline-block;
    margin-right: 6px;
    font-family: var(--brand-font-mono);
    font-size: 10px;
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
    border-top: 1px solid var(--glass-border);
  }
  .um-notes .um-prosemirror ::selection {
    background: color-mix(in oklab, var(--brand-accent-primary) 28%, transparent);
  }
  .um-notes .um-prosemirror > *:hover::before { opacity: 1; color: var(--brand-accent-primary); }
`;

type SaveState = "saved" | "saving" | "error";

export function NotesEditor({
  meeting,
  onMutate,
}: {
  meeting: Meeting;
  onMutate?: (updater: (current: Meeting) => Meeting) => void;
}) {
  const currentMs = usePlayerStore((state) => state.currentMs);
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const [mode, setMode] = useState<"rich" | "raw">("rich");
  const [raw, setRaw] = useState("");
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");

  const hostRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const slashRef = useRef<SlashState | null>(null);
  const currentMsRef = useRef(currentMs);
  const noteTimesRef = useRef<Array<number | null>>(meeting.notes.map((note) => note.startMs));
  const debounceTimerRef = useRef<number | null>(null);
  const pendingPayloadRef = useRef<SaveNotesInput | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  currentMsRef.current = currentMs;
  slashRef.current = slash;

  const flushSaveQueue = useCallback(
    (payload: SaveNotesInput) => {
      if (!isTauri() || meeting.isDemo) {
        setSaveState("saved");
        return;
      }
      setSaveState("saving");
      saveChainRef.current = saveChainRef.current
        .then(async () => {
          const savedBlocks = await saveNotes(payload);
          if (savedBlocks) {
            onMutate?.((curr) => ({
              ...curr,
              manualNotesRawMd: payload.rawMd,
              notes: savedBlocks.map((b) => ({
                id: b.id,
                lineIndex: b.lineIndex,
                startMs: b.recordingOffsetMs ?? 0,
                kind:
                  b.blockType === "heading"
                    ? "heading"
                    : b.blockType === "decision"
                      ? "decision"
                      : b.blockType === "todo"
                        ? "todo"
                        : b.blockType === "bookmark"
                          ? "bookmark"
                          : "note",
                text: b.contentMd,
                linkedScreenshotId: b.linkedScreenshotId,
              })),
            }));
          }
          setSaveState("saved");
        })
        .catch((error) => {
          console.warn("[memo] saveNotes failed", error);
          setSaveState("error");
        });
    },
    [meeting.isDemo, onMutate],
  );

  const scheduleAutosave = useCallback(
    (payload: SaveNotesInput) => {
      pendingPayloadRef.current = payload;
      if (!isTauri() || meeting.isDemo) return;
      setSaveState("saving");
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        const next = pendingPayloadRef.current;
        pendingPayloadRef.current = null;
        if (next) flushSaveQueue(next);
      }, 650);
    },
    [flushSaveQueue, meeting.isDemo],
  );

  useEffect(() => {
    const onImmediateSave = () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      const next = pendingPayloadRef.current;
      pendingPayloadRef.current = null;
      if (next) flushSaveQueue(next);
    };
    window.addEventListener("memo:save-notes", onImmediateSave);
    return () => window.removeEventListener("memo:save-notes", onImmediateSave);
  }, [flushSaveQueue]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (pendingPayloadRef.current) {
        const finalPayload = pendingPayloadRef.current;
        pendingPayloadRef.current = null;
        flushSaveQueue(finalPayload);
      }
    };
  }, [flushSaveQueue]);

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

  const initialHtml =
    meeting.manualNotesRawMd &&
    meeting.manualNotesRawMd.trim().length > 0 &&
    meeting.notes.length === 0
      ? markdownToHtml(meeting.manualNotesRawMd)
      : noteLinesToHtml(meeting.notes);

  const editor = useEditor(
    {
      extensions: [StarterKit],
      content: initialHtml,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: "um-prosemirror",
          spellcheck: "true",
          "aria-label": "Meeting notes editor",
        },
      },
      onCreate: ({ editor: instance }) => {
        noteTimesRef.current = meeting.notes.map((note) => note.startMs);
        applyGutter(instance);
      },
      onUpdate: ({ editor: instance }) => {
        applyGutter(instance);
        detectSlash(instance);
        const serialized = serializeRichEditorToNotePayload(
          instance.view.dom as HTMLElement,
          noteTimesRef.current,
        );
        noteTimesRef.current = serialized.offsetsMs;
        scheduleAutosave({
          meetingId: meeting.id,
          rawMd: serialized.rawMd,
          blocks: serialized.blocks,
        });
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

  const runSlideCaptureSideEffect = (time: string) => {
    if (isTauri() && !meeting.isDemo) {
      void captureScreenshot(meeting.id)
        .then((outcome) => {
          if (outcome?.deduplicated) {
            pushToast("Screenshot marker inserted", outcome.reason, "default");
          } else {
            pushToast("Slide captured & linked", `${time} · saved locally as WebP`, "success");
          }
        })
        .catch((error) => {
          pushToast("Screenshot capture failed", formatHostError(error), "danger");
        });
    } else {
      pushToast("Screenshot marker inserted", `${time} · pinned in notes`);
    }
  };

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
      runSlideCaptureSideEffect(time);
    }
    window.requestAnimationFrame(() => applyGutter(editor));
  };

  const insertBlockQuick = (command: SlashCommand) => {
    const time = formatTimestamp(usePlayerStore.getState().currentMs);
    if (mode === "raw") {
      const snippet =
        command.id === "decision"
          ? "\n> **Decision** "
          : command.id === "todo"
            ? "\n**TODO** `Unassigned` · `Not specified` · "
            : command.id === "shot"
              ? `\n**Screenshot ${time}** · `
              : `\n**Bookmark ${time}** · `;
      handleRawChange(`${raw}${snippet}`);
      if (command.id === "shot") runSlideCaptureSideEffect(time);
      return;
    }
    if (!editor) return;
    editor.chain().focus("end").insertContent(command.insert(time)).run();
    if (command.id === "shot") {
      runSlideCaptureSideEffect(time);
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
        if (isImeComposing(event)) return;
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
    const serialized = serializeRichEditorToNotePayload(
      editor.view.dom as HTMLElement,
      noteTimesRef.current,
    );
    noteTimesRef.current = serialized.offsetsMs;
    setRaw(serialized.rawMd || htmlToMarkdown(editor.getHTML()));
    setMode("raw");
    setSlash(null);
  };

  const switchToRich = () => {
    if (!editor) return;
    editor.commands.setContent(markdownToHtml(raw), false);
    setMode("rich");
    window.requestAnimationFrame(() => {
      const blocks = Array.from(editor.view.dom.children) as HTMLElement[];
      blocks.forEach((block, idx) => {
        const savedMs = noteTimesRef.current[idx];
        block.dataset.timestamp = formatTimestamp(savedMs ?? currentMsRef.current);
      });
    });
  };

  const handleRawChange = (nextRaw: string) => {
    setRaw(nextRaw);
    const serialized = serializeRawMarkdownToNotePayload(nextRaw, noteTimesRef.current);
    scheduleAutosave({
      meetingId: meeting.id,
      rawMd: serialized.rawMd,
      blocks: serialized.blocks,
    });
  };

  return (
    <section aria-label="Meeting notes" className="flex h-full min-h-0 flex-col bg-transparent">
      {/* Clean Glass Document Header */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] px-4">
        <div className="flex items-center gap-2">
          <FileCode2 className="size-4 text-accent-primary" aria-hidden="true" />
          <h2 className="text-[13px] font-semibold text-text-primary">Notes</h2>
          <span className="flex items-center gap-1 text-[11px] text-text-muted" aria-live="polite">
            {saveState === "saving" ? (
              <>
                <Loader2 className="size-3 animate-spin text-accent-primary" aria-hidden="true" />
                Saving…
              </>
            ) : saveState === "error" ? (
              <>
                <AlertCircle className="size-3 text-recording-pulse" aria-hidden="true" />
                <span className="text-recording-pulse">Save error</span>
              </>
            ) : (
              <span className="flex items-center gap-1 text-text-muted/75">
                <Check className="size-3 text-accent-primary" aria-hidden="true" />
                Saved
              </span>
            )}
          </span>
        </div>

        <div
          className="glass-subtle flex h-7 items-center rounded-xl p-0.5"
          role="group"
          aria-label="Note editor mode"
        >
          <button
            type="button"
            aria-pressed={mode === "rich"}
            onClick={() => mode === "raw" && switchToRich()}
            className={cn(
              "flex h-6 items-center gap-1 rounded-lg px-2.5 text-[11px] font-medium transition",
              mode === "rich"
                ? "bg-[var(--glass-surface-strong)] text-text-primary shadow-xs"
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
              "flex h-6 items-center gap-1 rounded-lg px-2.5 text-[11px] font-medium transition",
              mode === "raw"
                ? "bg-[var(--glass-surface-strong)] text-text-primary shadow-xs"
                : "text-text-muted hover:text-text-primary",
            )}
          >
            Markdown
          </button>
        </div>
      </div>

      {/* Editor Canvas */}
      <div ref={hostRef} className="um-notes relative min-h-0 flex-1 overflow-y-auto">
        <style dangerouslySetInnerHTML={{ __html: EDITOR_CSS }} />
        {mode === "rich" ? (
          <EditorContent editor={editor} />
        ) : (
          <textarea
            value={raw}
            onChange={(event) => handleRawChange(event.target.value)}
            aria-label="Raw Markdown notes"
            spellCheck={false}
            className="tabular min-h-full w-full flex-1 resize-none bg-transparent px-5 py-4 text-[13px] leading-[1.8] text-text-primary outline-none placeholder:text-text-muted/50"
            placeholder="# Meeting notes&#10;&#10;- Write timestamped thoughts…"
          />
        )}

        {slash && mode === "rich" && (
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Insert a note block"
            className="glass absolute z-40 w-[300px] overflow-hidden rounded-2xl p-1.5"
            style={{ left: slash.x, top: slash.y }}
          >
            <div className="flex items-center justify-between px-2.5 py-1.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                Insert block
              </span>
              <span className="flex items-center gap-1 font-mono text-[10px] text-text-muted/70">
                <Slash className="size-2.5" aria-hidden="true" />
                {slash.query || "…"}
              </span>
            </div>
            {filteredCommands.length === 0 ? (
              <p className="px-2.5 py-4 text-center text-xs text-text-muted">
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
                      "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition",
                      selected ? "bg-accent-primary/14" : "hover:bg-[var(--glass-surface-subtle)]",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border",
                        selected
                          ? "border-accent-primary/30 bg-accent-primary/14 text-accent-primary"
                          : "border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] text-text-muted",
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-text-primary">
                          {command.label}
                        </span>
                        <span className="font-mono text-[10px] text-text-muted/75">
                          {command.shortcut}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-text-muted">
                        {command.description}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* 1-Click Quick Block Insert Toolbar */}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] px-3.5 py-2 text-[11px] text-text-muted">
        <div className="flex flex-wrap items-center gap-1.5">
          {SLASH_COMMANDS.map((cmd) => {
            const Icon = cmd.icon;
            return (
              <button
                key={cmd.id}
                type="button"
                onClick={() => insertBlockQuick(cmd)}
                className="glass-subtle inline-flex h-6.5 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-text-muted transition hover:border-accent-primary/35 hover:text-text-primary"
              >
                <Plus className="size-2.5 text-accent-primary" aria-hidden="true" />
                <Icon className="size-3" aria-hidden="true" />
                <span>{cmd.label}</span>
              </button>
            );
          })}
        </div>
        <span className="hidden items-center gap-1 sm:inline-flex">
          Type <Kbd className="h-4 text-[10px]">/</Kbd> for commands
        </span>
      </footer>
    </section>
  );
}
