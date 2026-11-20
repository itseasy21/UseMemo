"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  ArrowUpRight,
  AtSign,
  BarChart3,
  Bot,
  CalendarClock,
  Camera,
  Check,
  ChevronsRight,
  FileText,
  ListChecks,
  Loader2,
  Mic,
  Plus,
  Sparkles,
  SquarePen,
  X,
} from "lucide-react";

import { AudioMeterHeader } from "@/components/meeting/AudioMeterHeader";
import { NotesEditor } from "@/components/meeting/NotesEditor";
import { EvidencePreview } from "@/components/synthesis/EvidencePreview";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { SlideThumbnail } from "@/components/ui/SlideThumbnail";
import {
  MEETINGS,
  PENDING_ACTIONS,
  meetingActionOwner,
  meetingHref,
  type Meeting,
} from "@/lib/demo-data";
import { formatTimestamp, pluralize } from "@/lib/format";
import {
  askAssistant,
  captureScreenshot,
  createSynthesisItem,
  listMeetings,
  listSynthesis,
  updateSynthesisItem,
  type MeetingRecord,
} from "@/lib/host";
import { isImeComposing } from "@/lib/ime";
import { searchVault } from "@/lib/search";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { useWorkspaceStore } from "@/stores/workspace";

type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  engineLabel?: string;
  citations?: Array<{
    label: string;
    href?: string;
    seekMs?: number;
  }>;
};

type VaultActionRow = {
  id: string;
  meetingId: string;
  meetingTitle: string;
  task: string;
  owner: string | null;
  deadline: string | null;
  done: boolean;
};

function segmentText(seg: Meeting["transcripts"][number]): string {
  return (seg.confirmedText || seg.unconfirmedText || "").trim();
}

function buildMeetingAnswerFallback(
  meeting: Meeting,
  question: string,
): { text: string; citations: ChatTurn["citations"] } {
  const q = question.toLowerCase();
  const citations: NonNullable<ChatTurn["citations"]> = [];

  if (q.includes("action") || q.includes("todo") || q.includes("task") || q.includes("owner")) {
    if (meeting.actions.length === 0) {
      return {
        text: `No action items have been extracted for "${meeting.title}" yet. Click Generate Summary in the Summary tab or add one in Live Assist.`,
        citations: [],
      };
    }
    const lines = meeting.actions.map((a) => {
      const owner = meetingActionOwner(meeting, a)?.name ?? a.ownerLabel ?? "Unassigned";
      const due = a.deadline ? ` (due ${a.deadline})` : "";
      return `• [${a.done ? "Done" : "Open"}] ${a.task} — ${owner}${due}`;
    });
    return {
      text: `Here are the ${meeting.actions.length} action items in "${meeting.title}":\n\n${lines.join("\n")}`,
      citations: meeting.transcripts.slice(0, 2).map((t) => ({
        label: formatTimestamp(t.startMs),
        seekMs: t.startMs,
      })),
    };
  }

  if (q.includes("decision") || q.includes("blocker") || q.includes("release")) {
    if (meeting.decisions.length > 0) {
      const lines = meeting.decisions.map((d, idx) => `${idx + 1}. ${d.text}`);
      return {
        text: `Key decisions & status updates from "${meeting.title}":\n\n${lines.join("\n")}`,
        citations: meeting.transcripts.slice(0, 3).map((t) => ({
          label: formatTimestamp(t.startMs),
          seekMs: t.startMs,
        })),
      };
    }
  }

  if (q.includes("slide") || q.includes("screenshot") || q.includes("screen")) {
    if (meeting.screenshots.length === 0) {
      return {
        text: `No slide screenshots were captured during "${meeting.title}".`,
        citations: [],
      };
    }
    const lines = meeting.screenshots.map(
      (s) =>
        `• [${formatTimestamp(s.startMs)}] ${s.title}: ${s.ocrExtractedText || s.slideText || s.caption}`,
    );
    return {
      text: `Captured ${meeting.screenshots.length} slide(s) in "${meeting.title}":\n\n${lines.slice(0, 5).join("\n")}`,
      citations: meeting.screenshots.slice(0, 4).map((s) => ({
        label: `Slide ${formatTimestamp(s.startMs)}`,
        seekMs: s.startMs,
      })),
    };
  }

  const terms = q
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const matchingSegs = meeting.transcripts.filter((seg) => {
    const body = segmentText(seg).toLowerCase();
    return body.length > 0 && terms.some((term) => body.includes(term));
  });

  if (matchingSegs.length > 0) {
    const snippets = matchingSegs
      .slice(0, 5)
      .map((s) => `• [${formatTimestamp(s.startMs)}] ${segmentText(s)}`);
    for (const seg of matchingSegs.slice(0, 4)) {
      citations.push({
        label: formatTimestamp(seg.startMs),
        seekMs: seg.startMs,
      });
    }
    return {
      text: `Found ${matchingSegs.length} matching transcript segment(s) in "${meeting.title}":\n\n${snippets.join("\n")}`,
      citations,
    };
  }

  const nonEmptySegs = meeting.transcripts.filter((t) => segmentText(t).length > 0);
  const summaryLines =
    meeting.summary.paragraphs.length > 0
      ? meeting.summary.paragraphs.map((p) => `• ${p.text}`).join("\n")
      : nonEmptySegs.length > 0
        ? nonEmptySegs
            .slice(0, 6)
            .map((t) => `• [${formatTimestamp(t.startMs)}] ${segmentText(t)}`)
            .join("\n")
        : meeting.notes.length > 0
          ? meeting.notes.map((n) => `• ${n.text}`).join("\n")
          : "No transcript or notes recorded yet.";

  const header =
    meeting.summary.paragraphs.length > 0
      ? meeting.summary.headline
      : `Overview of "${meeting.title}" (${nonEmptySegs.length} transcript segments):`;

  return {
    text: `${header}\n\n${summaryLines}`,
    citations: nonEmptySegs.slice(0, 3).map((t) => ({
      label: formatTimestamp(t.startMs),
      seekMs: t.startMs,
    })),
  };
}

export function RightAssistantPanel({
  mode,
  meeting,
  activeSpeakerId,
  currentMs = 0,
  onReload,
  onMutate,
}: {
  mode: "home" | "meeting";
  meeting?: Meeting;
  activeSpeakerId?: string | null;
  currentMs?: number;
  onReload?: () => Promise<void>;
  onMutate?: (updater: (current: Meeting) => Meeting) => void;
}) {
  const tabBaseId = useId();
  const rightPanelOpen = useWorkspaceStore((state) => state.rightPanelOpen);
  const setRightPanelOpen = useWorkspaceStore((state) => state.setRightPanelOpen);
  const homeTab = useWorkspaceStore((state) => state.homeRightTab);
  const setHomeTab = useWorkspaceStore((state) => state.setHomeRightTab);
  const meetingTab = useWorkspaceStore((state) => state.meetingRightTab);
  const setMeetingTab = useWorkspaceStore((state) => state.setMeetingRightTab);
  const aiPromptRequest = useWorkspaceStore((state) => state.aiPromptRequest);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const seek = usePlayerStore((state) => state.seek);

  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [scopedToMeeting, setScopedToMeeting] = useState(true);
  const [chatScopeMode, setChatScopeMode] = useState<"chat" | "vault">("chat");
  const [vaultActions, setVaultActions] = useState<VaultActionRow[]>([]);
  const [recentMeetings, setRecentMeetings] = useState<MeetingRecord[]>([]);
  const [newActionText, setNewActionText] = useState("");
  const [addingAction, setAddingAction] = useState(false);
  const [snappingSlide, setSnappingSlide] = useState(false);

  useEffect(() => {
    setScopedToMeeting(Boolean(meeting));
  }, [meeting?.id]);

  const loadVaultData = useCallback(async () => {
    if (!isTauri()) {
      setVaultActions(
        PENDING_ACTIONS.map((item) => ({
          id: item.action.id,
          meetingId: item.meeting.id,
          meetingTitle: item.meeting.title,
          task: item.action.task,
          owner:
            meetingActionOwner(item.meeting, item.action)?.name ?? item.action.ownerLabel ?? null,
          deadline: item.action.deadline ?? null,
          done: Boolean(item.action.done),
        })),
      );
      setRecentMeetings(
        MEETINGS.map((m, idx) => ({
          id: m.id,
          title: m.title,
          status: "completed",
          createdAt: new Date(m.startedAtISO).getTime(),
          updatedAt: new Date(m.startedAtISO).getTime(),
          durationMs: m.durationMs,
          audioFilePath: null,
          systemAudioFilePath: null,
          systemAudioStartedAtMs: 0,
          diarizationEnabled: true,
          screenshotIntervalSec: 10,
          asrModelId: "whisper-small",
          slmModelId: "gemma-3-4b-it",
          manualNotesRawMd: "",
          folderId: null,
          isStarred: idx === 0,
        })),
      );
      return;
    }

    const rows = (await listMeetings()) ?? [];
    setRecentMeetings(rows.slice(0, 12));
    const synthesisLists = await Promise.all(
      rows.slice(0, 15).map(async (m) => {
        const items = (await listSynthesis(m.id)) ?? [];
        return items
          .filter((item) => item.itemType === "action_item")
          .map((item) => ({
            id: item.id,
            meetingId: m.id,
            meetingTitle: m.title,
            task: item.content,
            owner: item.owner,
            deadline: item.deadline,
            done: item.isCompleted,
          }));
      }),
    );
    setVaultActions(synthesisLists.flat());
  }, []);

  useEffect(() => {
    if (mode === "home") {
      void loadVaultData();
    }
  }, [loadVaultData, mode]);

  const runPrompt = useCallback(
    async (rawText: string) => {
      const trimmed = rawText.trim();
      if (!trimmed || thinking) return;
      const userTurn: ChatTurn = {
        id: `u-${Date.now()}`,
        role: "user",
        text: trimmed,
      };
      setTurns((curr) => [...curr, userTurn]);
      setInput("");

      const targetMeetingId =
        meeting && scopedToMeeting && chatScopeMode === "chat" && !meeting.isDemo
          ? meeting.id
          : null;

      if (isTauri() && (!meeting || !meeting.isDemo)) {
        setThinking(true);
        try {
          const response = await askAssistant(trimmed, targetMeetingId);
          if (response) {
            setTurns((curr) => [
              ...curr,
              {
                id: `a-${Date.now()}`,
                role: "assistant",
                text: response.answer,
                engineLabel:
                  response.engineId === "llama-cpp-gguf" ? "On-device LLM" : "Local Vault",
                citations: response.citations.map((c) => ({
                  label: c.label,
                  href:
                    c.meetingId && (!meeting || c.meetingId !== meeting.id)
                      ? meetingHref(c.meetingId)
                      : undefined,
                  seekMs: typeof c.seekMs === "number" ? c.seekMs : undefined,
                })),
              },
            ]);
            setThinking(false);
            return;
          }
        } catch (err) {
          console.warn("[memo] ask_assistant fallback:", err);
        } finally {
          setThinking(false);
        }
      }

      if (meeting && scopedToMeeting) {
        const reply = buildMeetingAnswerFallback(meeting, trimmed);
        setTurns((curr) => [
          ...curr,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: reply.text,
            engineLabel: "Local Transcript",
            citations: reply.citations,
          },
        ]);
        return;
      }

      const demoHits = searchVault(trimmed, 4);
      const text =
        demoHits.length > 0
          ? demoHits.map((d) => `• ${d.meetingTitle}: ${d.snippet}`).join("\n\n")
          : `Reviewed ${MEETINGS.length} conversations and ${PENDING_ACTIONS.length} open action items.`;
      setTurns((curr) => [
        ...curr,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text,
          engineLabel: "Local Vault",
          citations: demoHits.slice(0, 3).map((d) => ({
            label: d.meetingTitle,
            href: meetingHref(d.meetingId),
          })),
        },
      ]);
    },
    [chatScopeMode, meeting, scopedToMeeting, thinking],
  );

  useEffect(() => {
    if (!aiPromptRequest) return;
    void runPrompt(aiPromptRequest.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPromptRequest?.nonce]);

  const handleToggleVaultAction = async (row: VaultActionRow) => {
    const nextDone = !row.done;
    setVaultActions((curr) =>
      curr.map((item) => (item.id === row.id ? { ...item, done: nextDone } : item)),
    );
    if (isTauri()) {
      try {
        await updateSynthesisItem(row.id, { isCompleted: nextDone });
      } catch (err) {
        pushToast("Could not update action item", formatHostError(err), "danger");
      }
    }
  };

  const handleAddMeetingAction = async () => {
    const trimmed = newActionText.trim();
    if (!trimmed || !meeting || addingAction) return;
    setAddingAction(true);
    try {
      if (isTauri() && !meeting.isDemo) {
        await createSynthesisItem({
          meetingId: meeting.id,
          itemType: "action_item",
          content: trimmed,
          owner: "You",
        });
        await onReload?.();
      } else {
        onMutate?.((curr) => ({
          ...curr,
          actions: [
            ...curr.actions,
            {
              id: `act-${Date.now()}`,
              task: trimmed,
              ownerLabel: "You",
              done: false,
              userEdited: true,
              evidence: [],
            },
          ],
        }));
      }
      setNewActionText("");
      pushToast("Action item added", trimmed, "success");
    } catch (err) {
      pushToast("Could not add action item", formatHostError(err), "danger");
    } finally {
      setAddingAction(false);
    }
  };

  const handleToggleMeetingAction = async (action: Meeting["actions"][number]) => {
    if (!meeting) return;
    const nextDone = !action.done;
    onMutate?.((curr) => ({
      ...curr,
      actions: curr.actions.map((a) => (a.id === action.id ? { ...a, done: nextDone } : a)),
    }));
    if (isTauri() && !meeting.isDemo) {
      try {
        await updateSynthesisItem(action.id, { isCompleted: nextDone });
      } catch (err) {
        pushToast("Could not update action item", formatHostError(err), "danger");
      }
    }
  };

  const handleQuickSnap = async () => {
    if (!meeting || snappingSlide) return;
    if (!isTauri() || meeting.isDemo) {
      pushToast("Slide captured", "Saved locally as WebP.", "success");
      return;
    }
    setSnappingSlide(true);
    try {
      const outcome = await captureScreenshot(meeting.id);
      if (outcome?.deduplicated) {
        pushToast("Slide unchanged", outcome.reason, "default");
      } else {
        await onReload?.();
        pushToast("Slide captured", "Saved locally as WebP.", "success");
      }
    } catch (err) {
      pushToast("Could not capture slide", formatHostError(err), "danger");
    } finally {
      setSnappingSlide(false);
    }
  };

  const speakerStats = useMemo(() => {
    if (!meeting) return [];
    const counts = new Map<string, { name: string; segments: number; words: number }>();
    let totalWords = 0;
    for (const seg of meeting.transcripts) {
      const speaker =
        meeting.participants.find((p) => p.id === seg.speakerId)?.name ||
        seg.speakerLabelRaw ||
        "You";
      const words = segmentText(seg).split(/\s+/).filter(Boolean).length;
      totalWords += words;
      const prev = counts.get(speaker) ?? { name: speaker, segments: 0, words: 0 };
      prev.segments += 1;
      prev.words += words;
      counts.set(speaker, prev);
    }
    return [...counts.values()].map((entry) => ({
      ...entry,
      share: totalWords > 0 ? Math.round((entry.words / totalWords) * 100) : 100,
    }));
  }, [meeting]);

  const suggestedPrompts = useMemo(() => {
    if (meeting && scopedToMeeting) {
      return [
        "What was discussed in this meeting?",
        "List action items and next steps",
        "Summarize key decisions & slides",
      ];
    }
    return [
      "Track release readiness and blockers",
      "Find open action items & follow-ups",
      "Summarize latest meeting notes",
    ];
  }, [meeting, scopedToMeeting]);

  if (!rightPanelOpen) return null;

  const activeTab = mode === "home" ? homeTab : meetingTab;
  const openActionCount = vaultActions.filter((a) => !a.done).length || vaultActions.length;

  return (
    <aside
      aria-label="AI Assistant and workspace tools"
      className="hidden h-full w-[348px] shrink-0 flex-col border-l border-[var(--glass-border)] bg-[var(--glass-surface)] backdrop-blur-2xl xl:flex 2xl:w-[380px]"
    >
      {/* Top Otter-style Underline Tab Bar */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--glass-border)] px-3.5">
        <div
          role="tablist"
          aria-label={mode === "home" ? "Workspace assistant tabs" : "Meeting assistant tabs"}
          className="flex h-full items-center gap-4"
        >
          {mode === "home" ? (
            <>
              <button
                type="button"
                role="tab"
                id={`${tabBaseId}-chat`}
                aria-selected={homeTab === "chat"}
                onClick={() => setHomeTab("chat")}
                className="um-tab flex h-full items-center gap-1.5 text-xs font-semibold"
              >
                AI Chat
              </button>
              <button
                type="button"
                role="tab"
                id={`${tabBaseId}-meetings`}
                aria-selected={homeTab === "meetings"}
                onClick={() => setHomeTab("meetings")}
                className="um-tab flex h-full items-center gap-1.5 text-xs font-semibold"
              >
                Meetings
              </button>
              <button
                type="button"
                role="tab"
                id={`${tabBaseId}-actions`}
                aria-selected={homeTab === "actions"}
                onClick={() => setHomeTab("actions")}
                className="um-tab flex h-full items-center gap-1.5 text-xs font-semibold"
              >
                Action Items ({openActionCount})
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="tab"
                id={`${tabBaseId}-chat`}
                aria-selected={meetingTab === "chat"}
                onClick={() => setMeetingTab("chat")}
                className="um-tab flex h-full items-center gap-1.5 text-xs font-semibold"
              >
                AI Chat
              </button>
              <button
                type="button"
                role="tab"
                id={`${tabBaseId}-notes`}
                aria-selected={meetingTab === "notes"}
                onClick={() => setMeetingTab("notes")}
                className="um-tab flex h-full items-center gap-1.5 text-xs font-semibold"
              >
                Notes
              </button>
              <button
                type="button"
                role="tab"
                id={`${tabBaseId}-assist`}
                aria-selected={meetingTab === "assist"}
                onClick={() => setMeetingTab("assist")}
                className="um-tab flex h-full items-center gap-1.5 text-xs font-semibold"
              >
                Live Assist
              </button>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setRightPanelOpen(false)}
          aria-label="Collapse assistant panel"
          title="Collapse panel"
          className="flex size-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary"
        >
          <ChevronsRight className="size-4" aria-hidden="true" />
        </button>
      </div>

      {/* Tab Panel 1: AI Chat (Home & Meeting) */}
      {activeTab === "chat" && (
        <div
          role="tabpanel"
          aria-labelledby={`${tabBaseId}-chat`}
          className="flex min-h-0 flex-1 flex-col"
        >
          {/* Subheader: New chat */}
          <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
              <span className="flex size-6 items-center justify-center rounded-full bg-accent-primary/15 text-accent-primary">
                <Bot className="size-3.5" aria-hidden="true" />
              </span>
              <span>Local AI Assistant</span>
              <span className="size-1.5 rounded-full bg-accent-primary" />
            </div>
            {turns.length > 0 && (
              <button
                type="button"
                onClick={() => setTurns([])}
                title="Start new chat"
                aria-label="Start new chat"
                className="flex size-7 items-center justify-center rounded-lg border border-[var(--glass-border)] text-text-muted transition hover:text-text-primary"
              >
                <SquarePen className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Chat Message Stream */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-2">
            {turns.length === 0 ? (
              <div className="mt-auto space-y-2 pb-3">
                <p className="px-1 pb-1 text-[11px] text-text-muted">
                  Ask anything about{" "}
                  {meeting && scopedToMeeting ? `"${meeting.title}"` : "your vault"}:
                </p>
                {suggestedPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void runPrompt(prompt)}
                    className="glass-subtle flex w-fit max-w-full items-center gap-2 rounded-full px-3.5 py-2 text-left text-xs font-medium text-text-primary transition hover:border-accent-primary/40 hover:bg-accent-primary/10"
                  >
                    <Sparkles
                      className="size-3.5 shrink-0 text-accent-primary"
                      aria-hidden="true"
                    />
                    <span className="truncate">{prompt}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3 py-2">
                {turns.map((turn) => (
                  <div
                    key={turn.id}
                    className={cn(
                      "rounded-2xl px-3.5 py-2.5 text-xs leading-5",
                      turn.role === "user"
                        ? "ml-6 bg-accent-primary/14 font-medium text-text-primary"
                        : "glass-subtle mr-2 text-text-primary/92",
                    )}
                  >
                    {turn.engineLabel && (
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-primary">
                        {turn.engineLabel}
                      </span>
                    )}
                    <p className="whitespace-pre-line">{turn.text}</p>
                    {turn.citations && turn.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-[var(--glass-border)] pt-2">
                        {turn.citations.map((cite, idx) =>
                          cite.href ? (
                            <Link
                              key={idx}
                              href={cite.href}
                              className="inline-flex items-center gap-1 rounded-full border border-accent-primary/30 bg-accent-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-accent-primary hover:brightness-110"
                            >
                              {cite.label}
                              <ArrowUpRight className="size-2.5" aria-hidden="true" />
                            </Link>
                          ) : (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                if (typeof cite.seekMs === "number") seek(cite.seekMs);
                              }}
                              className="tabular inline-flex items-center gap-1 rounded-full border border-accent-primary/30 bg-accent-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-accent-primary hover:brightness-110"
                            >
                              {cite.label}
                            </button>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {thinking && (
                  <div className="glass-subtle mr-6 flex items-center gap-2 rounded-2xl px-3.5 py-2.5 text-xs text-text-muted">
                    <Loader2
                      className="size-3.5 animate-spin text-accent-primary"
                      aria-hidden="true"
                    />
                    <span>Analyzing meeting locally…</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Otter-style Rounded Composer Box */}
          <div className="shrink-0 p-3.5 pt-1">
            <div className="rounded-2xl border border-[var(--glass-border-strong)] bg-[var(--glass-surface-subtle)] p-3 shadow-xs transition focus-within:border-accent-primary/50">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {meeting && scopedToMeeting ? (
                  <>
                    <span className="inline-flex size-6 items-center justify-center rounded-full border border-[var(--glass-border-strong)] text-text-muted">
                      <AtSign className="size-3" aria-hidden="true" />
                    </span>
                    <span className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-[var(--glass-border-strong)] bg-[var(--glass-surface)] px-2.5 py-0.5 text-[11px] font-medium text-text-primary">
                      <FileText
                        className="size-3 shrink-0 text-accent-primary"
                        aria-hidden="true"
                      />
                      <span className="truncate">{meeting.title}</span>
                      <button
                        type="button"
                        onClick={() => setScopedToMeeting(false)}
                        aria-label="Search across all meetings instead"
                        className="text-text-muted hover:text-text-primary"
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </span>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (meeting) setScopedToMeeting(true);
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--glass-border-strong)] bg-[var(--glass-surface)] px-2.5 py-0.5 text-[11px] font-medium text-text-muted transition hover:text-text-primary"
                  >
                    <AtSign className="size-3" aria-hidden="true" />
                    <span>{meeting ? `Scope to ${meeting.title}` : "All local conversations"}</span>
                  </button>
                )}
              </div>

              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (isImeComposing(e)) return;
                    void runPrompt(input);
                  }
                }}
                rows={2}
                placeholder="Ask anything about your conversations"
                aria-label="Ask anything about your conversations"
                className="w-full resize-none bg-transparent text-xs leading-5 text-text-primary outline-none placeholder:text-text-muted/70"
              />

              <div className="mt-1.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={openNewRecording}
                    title="Start a new recording"
                    aria-label="Start a new recording"
                    className="flex size-6.5 items-center justify-center rounded-full border border-[var(--glass-border-strong)] text-text-muted transition hover:text-text-primary"
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                  </button>
                  <div className="flex items-center rounded-full border border-[var(--glass-border)] bg-[var(--glass-surface)] p-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => {
                        setChatScopeMode("chat");
                        if (meeting) setScopedToMeeting(true);
                      }}
                      className={cn(
                        "rounded-full px-2.5 py-0.5 font-medium transition",
                        chatScopeMode === "chat"
                          ? "bg-accent-primary/15 text-accent-primary"
                          : "text-text-muted hover:text-text-primary",
                      )}
                    >
                      Chat
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setChatScopeMode("vault");
                        setScopedToMeeting(false);
                      }}
                      className={cn(
                        "rounded-full px-2.5 py-0.5 font-medium transition",
                        chatScopeMode === "vault"
                          ? "bg-accent-primary/15 text-accent-primary"
                          : "text-text-muted hover:text-text-primary",
                      )}
                    >
                      Vault
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!input.trim() || thinking}
                  onClick={() => void runPrompt(input)}
                  aria-label="Send question"
                  className="flex size-7 items-center justify-center rounded-full bg-accent-primary text-bg-primary transition hover:brightness-105 disabled:opacity-35"
                >
                  <ArrowUp className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
            <p className="mt-1.5 text-center text-[10.5px] text-text-muted/70">
              Runs 100% locally on your Mac. Click timestamps to jump audio.
            </p>
          </div>
        </div>
      )}

      {/* Tab Panel 2 (Home): Action Items Tracker */}
      {mode === "home" && activeTab === "actions" && (
        <div
          role="tabpanel"
          aria-labelledby={`${tabBaseId}-actions`}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3.5"
        >
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold text-text-primary">Action Items Across Meetings</p>
            <Pill tone="accent">{openActionCount} open</Pill>
          </div>

          {vaultActions.length === 0 ? (
            <div className="my-auto py-12 text-center">
              <ListChecks className="mx-auto size-7 text-text-muted/50" aria-hidden="true" />
              <p className="mt-2.5 text-xs font-medium text-text-primary">No action items yet</p>
              <p className="mt-1 text-[11px] leading-4 text-text-muted">
                Generate an AI Summary inside any meeting to automatically extract action items and
                owners.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {vaultActions.map((item) => (
                <div
                  key={item.id}
                  className="glass-subtle rounded-xl p-3 transition hover:border-[var(--glass-border-strong)]"
                >
                  <div className="flex items-start gap-2.5">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={item.done}
                      onClick={() => void handleToggleVaultAction(item)}
                      className={cn(
                        "mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded border transition",
                        item.done
                          ? "border-accent-primary bg-accent-primary text-bg-primary"
                          : "border-[var(--glass-border-strong)] bg-transparent hover:border-accent-primary",
                      )}
                    >
                      {item.done && <Check className="size-3" aria-hidden="true" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          "text-xs leading-5 text-text-primary",
                          item.done && "line-through opacity-55",
                        )}
                      >
                        {item.task}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
                        <Link
                          href={meetingHref(item.meetingId)}
                          className="truncate text-[11px] font-medium text-accent-primary hover:underline"
                        >
                          {item.meetingTitle}
                        </Link>
                        <div className="flex items-center gap-1.5">
                          {item.deadline && (
                            <span className="tabular flex items-center gap-1 text-[10px] text-text-muted">
                              <CalendarClock className="size-2.5" aria-hidden="true" />
                              {item.deadline}
                            </span>
                          )}
                          {item.owner && (
                            <Avatar
                              name={item.owner}
                              tone="accent"
                              size="xs"
                              className="size-4.5"
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab Panel 3 (Home): Meetings Quick List */}
      {mode === "home" && activeTab === "meetings" && (
        <div
          role="tabpanel"
          aria-labelledby={`${tabBaseId}-meetings`}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3.5"
        >
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold text-text-primary">Recent Recordings</p>
            <button
              type="button"
              onClick={openNewRecording}
              className="inline-flex items-center gap-1 text-xs font-medium text-accent-primary hover:underline"
            >
              <Mic className="size-3" aria-hidden="true" />
              New
            </button>
          </div>

          <div className="space-y-1.5">
            {recentMeetings.map((m) => (
              <Link
                key={m.id}
                href={meetingHref(m.id)}
                className="glass-subtle flex items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 transition hover:border-accent-primary/35"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-text-primary">{m.title}</p>
                  <p className="mt-0.5 text-[11px] text-text-muted">
                    {new Date(m.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    · {formatTimestamp(m.durationMs)}
                  </p>
                </div>
                <ArrowUpRight className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Tab Panel 2 (Meeting): Side-by-Side Live Notes Editor */}
      {mode === "meeting" && meeting && activeTab === "notes" && (
        <div
          role="tabpanel"
          aria-labelledby={`${tabBaseId}-notes`}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <NotesEditor meeting={meeting} onMutate={onMutate} />
        </div>
      )}

      {/* Tab Panel 3 (Meeting): Live Assist (Co-Pilot: Action Items + Speaker Stats + Slides + Audio Mixer) */}
      {mode === "meeting" && meeting && activeTab === "assist" && (
        <div
          role="tabpanel"
          aria-labelledby={`${tabBaseId}-assist`}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {/* Audio Channels & Gain Mixer */}
          <AudioMeterHeader
            meeting={meeting}
            activeSpeakerId={activeSpeakerId ?? null}
            currentMs={currentMs}
            onReload={onReload}
          />

          <div className="space-y-3.5 p-3.5">
            {/* 1. Live Action Items & Quick Add */}
            <div className="glass-subtle rounded-2xl p-3.5">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                  <ListChecks className="size-3.5 text-accent-primary" aria-hidden="true" />
                  Action Items
                </h3>
                <Pill tone="accent">{meeting.actions.length}</Pill>
              </div>

              <div className="mt-2.5 flex items-center gap-1.5">
                <input
                  value={newActionText}
                  onChange={(e) => setNewActionText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (isImeComposing(e)) return;
                      void handleAddMeetingAction();
                    }
                  }}
                  placeholder="+ Add action item…"
                  aria-label="New action item"
                  className="glass-input h-8 min-w-0 flex-1 px-2.5 text-xs text-text-primary outline-none"
                />
                <Button
                  variant="primary"
                  size="xs"
                  disabled={!newActionText.trim() || addingAction}
                  onClick={() => void handleAddMeetingAction()}
                >
                  Add
                </Button>
              </div>

              {meeting.actions.length > 0 && (
                <div className="mt-2.5 space-y-1.5">
                  {meeting.actions.map((act) => (
                    <div
                      key={act.id}
                      className="flex items-start gap-2 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface)] px-2.5 py-2 text-xs"
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={Boolean(act.done)}
                        onClick={() => void handleToggleMeetingAction(act)}
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition",
                          act.done
                            ? "border-accent-primary bg-accent-primary text-bg-primary"
                            : "border-[var(--glass-border-strong)] bg-transparent",
                        )}
                      >
                        {act.done && <Check className="size-2.5" aria-hidden="true" />}
                      </button>
                      <span
                        className={cn(
                          "flex-1 leading-4 text-text-primary",
                          act.done && "line-through opacity-55",
                        )}
                      >
                        {act.task}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 2. Speaker Talk-Time & Breakdown */}
            <div className="glass-subtle rounded-2xl p-3.5">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                <BarChart3 className="size-3.5 text-accent-secondary" aria-hidden="true" />
                Speaker Talk Time
              </h3>
              {speakerStats.length === 0 ? (
                <p className="mt-2 text-[11px] text-text-muted">
                  Transcribe or record speech to see speaker talk-time breakdown.
                </p>
              ) : (
                <div className="mt-2.5 space-y-2.5">
                  {speakerStats.map((spk) => (
                    <div key={spk.name}>
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-text-primary">{spk.name}</span>
                        <span className="tabular text-[11px] text-text-muted">
                          {spk.share}% · {spk.words} {pluralize(spk.words, "word")}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--glass-surface)]">
                        <div
                          className="h-full rounded-full bg-accent-primary transition-all"
                          style={{ width: `${Math.max(6, spk.share)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 3. Slide Snapshots & Quick Capture */}
            <div className="glass-subtle rounded-2xl p-3.5">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                  <Camera className="size-3.5 text-accent-primary" aria-hidden="true" />
                  Slides ({meeting.screenshots.length})
                </h3>
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={snappingSlide}
                  onClick={() => void handleQuickSnap()}
                >
                  {snappingSlide ? "Snapping…" : "Snap Slide"}
                </Button>
              </div>
              {meeting.screenshots.length > 0 && (
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  {meeting.screenshots.map((shot) => (
                    <button
                      key={shot.id}
                      type="button"
                      onClick={() => seek(shot.startMs)}
                      className="overflow-hidden rounded-xl border border-[var(--glass-border)] text-left transition hover:border-accent-primary/45"
                    >
                      <SlideThumbnail
                        screenshot={shot}
                        compact
                        showTime
                        className="rounded-none border-0"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 4. Source Citation Inspector */}
            <EvidencePreview meeting={meeting} className="max-h-[300px]" />
          </div>
        </div>
      )}
    </aside>
  );
}
