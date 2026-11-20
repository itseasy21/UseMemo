"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import {
  AudioLines,
  Calendar,
  CalendarClock,
  Camera,
  Check,
  Clock,
  Copy,
  Image as ImageIcon,
  Loader2,
  PencilLine,
  RefreshCw,
  Sparkles,
  Star,
} from "lucide-react";

import { AudioMeterHeader } from "@/components/meeting/AudioMeterHeader";
import { NotesEditor } from "@/components/meeting/NotesEditor";
import { ScreenshotCard } from "@/components/meeting/ScreenshotCard";
import { TimelineDock } from "@/components/meeting/TimelineDock";
import { TranscriptPane } from "@/components/meeting/TranscriptPane";
import { AppShell } from "@/components/shell/AppShell";
import { EvidenceChips } from "@/components/synthesis/EvidenceChip";
import { Avatar } from "@/components/ui/Avatar";
import { Button, buttonClass } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useBrand } from "@/components/providers/BrandProvider";
import { useSynthesisProgress } from "@/hooks/use-host-event";
import { meetingActionOwner, type ActionItem, type Decision, type Meeting } from "@/lib/demo-data";
import { formatDuration, pluralize } from "@/lib/format";
import {
  captureScreenshot,
  setMeetingStarred,
  synthesizeMeeting,
  transcribeMeeting,
  updateMeeting,
  updateSynthesisItem,
} from "@/lib/host";
import { isImeComposing } from "@/lib/ime";
import { SEEK_HANDOFF_PREFIX } from "@/lib/session-keys";
import { formatHostError, isTauri, toAssetUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { speakerLabel, useWorkspaceStore } from "@/stores/workspace";

export type MeetingDocTab = "summary" | "notes" | "transcript" | "slides";

const TEMPLATES = [
  { id: "general", label: "General" },
  { id: "soap", label: "Clinical SOAP" },
  { id: "exec", label: "Executive Brief" },
  { id: "sync", label: "1:1 Check-in" },
] as const;

function EditableDecisionBullet({
  meeting,
  decision,
  onSaveText,
}: {
  meeting: Meeting;
  decision: Decision;
  onSaveText: (id: string, nextText: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(decision.text);

  useEffect(() => {
    setDraft(decision.text);
  }, [decision.text]);

  const commit = async () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed || trimmed === decision.text) {
      setDraft(decision.text);
      return;
    }
    await onSaveText(decision.id, trimmed);
  };

  return (
    <li className="group relative pl-1 text-[14px] leading-[1.68] text-text-primary/92">
      {editing ? (
        <div className="my-1 flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (isImeComposing(e)) return;
                void commit();
              } else if (e.key === "Escape") {
                setDraft(decision.text);
                setEditing(false);
              }
            }}
            autoFocus
            aria-label="Edit decision"
            className="glass-input h-8 flex-1 px-2.5 text-xs text-text-primary outline-none"
          />
          <Button variant="primary" size="xs" onClick={() => void commit()}>
            Save
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="inline">
          <span>{decision.text}</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Edit decision"
            className="ml-1.5 inline-flex size-5 items-center justify-center rounded text-text-muted opacity-0 transition group-hover:opacity-100 hover:text-text-primary"
          >
            <PencilLine className="size-3" aria-hidden="true" />
          </button>
          {decision.evidence.length > 0 && (
            <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle">
              <EvidenceChips meeting={meeting} evidence={decision.evidence} />
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function OtterActionItemRow({
  meeting,
  action,
  onToggle,
  onSaveFields,
}: {
  meeting: Meeting;
  action: ActionItem;
  onToggle: () => void;
  onSaveFields: (patch: { content?: string; owner?: string; deadline?: string }) => Promise<void>;
}) {
  const labels = useWorkspaceStore((state) => state.speakerLabels);
  const owner = meetingActionOwner(meeting, action);
  const ownerName = owner
    ? speakerLabel(labels, meeting.id, owner.id, owner.name)
    : action.ownerLabel || null;

  const [editing, setEditing] = useState(false);
  const [taskDraft, setTaskDraft] = useState(action.task);
  const [ownerDraft, setOwnerDraft] = useState(ownerName ?? "");
  const [deadlineDraft, setDeadlineDraft] = useState(action.deadline ?? "");

  useEffect(() => {
    setTaskDraft(action.task);
    setOwnerDraft(ownerName ?? "");
    setDeadlineDraft(action.deadline ?? "");
  }, [action.deadline, action.task, ownerName]);

  const commit = async () => {
    setEditing(false);
    await onSaveFields({
      content: taskDraft.trim() || action.task,
      owner: ownerDraft.trim() || "Unassigned",
      deadline: deadlineDraft.trim() || "Not specified",
    });
  };

  return (
    <div className="group flex items-start gap-3 rounded-xl px-2 py-2.5 transition hover:bg-[var(--glass-surface-subtle)]">
      <button
        type="button"
        role="checkbox"
        aria-checked={Boolean(action.done)}
        aria-label={`${action.done ? "Mark incomplete" : "Mark complete"}: ${action.task}`}
        onClick={onToggle}
        className={cn(
          "mt-1 flex size-4.5 shrink-0 items-center justify-center rounded border transition",
          action.done
            ? "border-accent-primary bg-accent-primary text-bg-primary"
            : "border-[var(--glass-border-strong)] bg-transparent hover:border-accent-primary",
        )}
      >
        {action.done && <Check className="size-3" aria-hidden="true" />}
      </button>

      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={taskDraft}
              onChange={(e) => setTaskDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (isImeComposing(e)) return;
                  void commit();
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              aria-label="Action item task"
              autoFocus
              className="glass-input h-8 min-w-[200px] flex-1 px-2.5 text-xs text-text-primary outline-none"
            />
            <input
              value={ownerDraft}
              onChange={(e) => setOwnerDraft(e.target.value)}
              placeholder="Assignee"
              aria-label="Action item owner"
              className="glass-input h-8 w-28 px-2.5 text-xs text-text-primary outline-none"
            />
            <input
              value={deadlineDraft}
              onChange={(e) => setDeadlineDraft(e.target.value)}
              placeholder="Due date"
              aria-label="Action item due date"
              className="glass-input h-8 w-24 px-2.5 text-xs text-text-primary outline-none"
            />
            <Button variant="primary" size="xs" onClick={() => void commit()}>
              Save
            </Button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-[14px] leading-[1.6] text-text-primary",
                  action.done && "line-through opacity-55",
                )}
              >
                {action.task}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {action.deadline && (
                  <span className="tabular inline-flex items-center gap-1 text-xs text-text-muted">
                    <CalendarClock className="size-3" aria-hidden="true" />
                    {action.deadline}
                  </span>
                )}
                {action.evidence.length > 0 && (
                  <EvidenceChips meeting={meeting} evidence={action.evidence} />
                )}
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  aria-label={`Edit action: ${action.task}`}
                  className="inline-flex items-center gap-1 text-xs text-text-muted opacity-0 transition group-hover:opacity-100 hover:text-text-primary"
                >
                  <PencilLine className="size-3" aria-hidden="true" />
                  Edit
                </button>
              </div>
            </div>

            {/* Right-aligned Owner Avatar (Otter style) */}
            <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
              {ownerName && ownerName.toLowerCase() !== "unassigned" ? (
                <span
                  title={`Assigned to ${ownerName}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] px-2 py-0.5 text-xs text-text-primary"
                >
                  <Avatar
                    name={ownerName}
                    tone={owner?.tone ?? "accent"}
                    size="xs"
                    className="size-4.5"
                  />
                  <span className="hidden sm:inline">{ownerName}</span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded-full border border-dashed border-[var(--glass-border-strong)] px-2 py-0.5 text-[11px] text-text-muted transition hover:border-accent-primary/40 hover:text-text-primary"
                >
                  + Assign
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function MeetingStudio({
  meeting,
  initialTab,
  onReload,
  onMutate,
}: {
  meeting: Meeting;
  initialTab?: MeetingDocTab;
  onReload?: () => Promise<void>;
  onMutate?: (updater: (current: Meeting) => Meeting) => void;
}) {
  const tabBaseId = useId();
  const brand = useBrand();
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const triggerAiPrompt = useWorkspaceStore((state) => state.triggerAiPrompt);
  const setMeetingRightTab = useWorkspaceStore((state) => state.setMeetingRightTab);

  const loadMedia = usePlayerStore((state) => state.loadMedia);
  const teardown = usePlayerStore((state) => state.teardown);
  const tick = usePlayerStore((state) => state.tick);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const hasRealAudio = usePlayerStore((state) => state.hasRealAudio);
  const togglePlaying = usePlayerStore((state) => state.togglePlaying);
  const currentMs = usePlayerStore((state) => state.currentMs);

  const defaultTab: MeetingDocTab =
    initialTab ??
    (meeting.status === "recording"
      ? "transcript"
      : meeting.summary.paragraphs.length > 0 || meeting.actions.length > 0 || meeting.isDemo
        ? "summary"
        : meeting.transcripts.length > 0
          ? "transcript"
          : "notes");

  const [activeTab, setActiveTab] = useState<MeetingDocTab>(defaultTab);
  const [template, setTemplate] = useState<string>("general");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(meeting.title);
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthProgress, setSynthProgress] = useState<number | null>(null);
  const [synthError, setSynthError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [snapping, setSnapping] = useState(false);

  useEffect(() => {
    setTitleDraft(meeting.title);
  }, [meeting.title]);

  useEffect(() => {
    let startMs = meeting.isDemo
      ? (meeting.transcripts[Math.floor(meeting.transcripts.length / 2)]?.startMs ?? 0)
      : 0;
    try {
      const key = `${SEEK_HANDOFF_PREFIX}${meeting.id}`;
      const handoff = window.sessionStorage.getItem(key);
      if (handoff) {
        const parsed = Number(handoff);
        if (Number.isFinite(parsed)) startMs = parsed;
        window.sessionStorage.removeItem(key);
      }
    } catch {
      // Session handoff is optional.
    }

    loadMedia({
      meetingId: meeting.id,
      durationMs: meeting.durationMs,
      startMs,
      micSrc: toAssetUrl(meeting.audioFilePath),
      systemSrc: toAssetUrl(meeting.systemAudioFilePath),
      systemOffsetMs: meeting.systemAudioStartedAtMs ?? 0,
    });

    return () => {
      teardown();
    };
  }, [
    loadMedia,
    meeting.audioFilePath,
    meeting.durationMs,
    meeting.id,
    meeting.isDemo,
    meeting.systemAudioFilePath,
    meeting.systemAudioStartedAtMs,
    teardown,
  ]);

  useEffect(() => {
    if (!isPlaying || hasRealAudio) return;
    const timer = window.setInterval(() => tick(250), 250);
    return () => window.clearInterval(timer);
  }, [hasRealAudio, isPlaying, tick]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']") ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      togglePlaying();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlaying]);

  useSynthesisProgress((payload) => {
    if (payload.meetingId !== meeting.id) return;
    setSynthProgress(payload.percent);
    if (payload.stage === "complete" || payload.stage === "failed") {
      setSynthesizing(false);
    }
  });

  const activeSegment =
    [...meeting.transcripts].reverse().find((segment) => segment.startMs <= currentMs) ??
    meeting.transcripts[0];
  const activeSegmentId = activeSegment?.id ?? null;
  const activeSpeakerId = activeSegment?.speakerId ?? null;

  const commitTitle = async () => {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (!trimmed || trimmed === meeting.title) {
      setTitleDraft(meeting.title);
      return;
    }
    onMutate?.((curr) => ({ ...curr, title: trimmed }));
    if (isTauri() && !meeting.isDemo) {
      try {
        await updateMeeting(meeting.id, { title: trimmed });
        pushToast("Renamed meeting", trimmed, "success");
      } catch (error) {
        onMutate?.((curr) => ({ ...curr, title: meeting.title }));
        pushToast("Could not rename meeting", formatHostError(error), "danger");
      }
    }
  };

  const toggleStar = async () => {
    const next = !meeting.isStarred;
    onMutate?.((curr) => ({ ...curr, isStarred: next }));
    if (isTauri() && !meeting.isDemo) {
      try {
        await setMeetingStarred(meeting.id, next);
      } catch (error) {
        onMutate?.((curr) => ({ ...curr, isStarred: !next }));
        pushToast("Could not update star", formatHostError(error), "danger");
      }
    }
  };

  const handleCopySummary = async () => {
    const lines: string[] = [
      `# ${meeting.title}`,
      `${meeting.dateLabel} · ${formatDuration(meeting.durationMs)}`,
      "",
      "## Overview",
      meeting.summary.headline,
      "",
      ...meeting.summary.paragraphs.map((p) => `- ${p.text}`),
    ];
    if (meeting.decisions.length > 0) {
      lines.push("", "## Decisions", ...meeting.decisions.map((d) => `- ${d.text}`));
    }
    if (meeting.actions.length > 0) {
      lines.push(
        "",
        "## Action Items",
        ...meeting.actions.map((a) => `- [${a.done ? "x" : " "}] ${a.task}`),
      );
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast("Summary copied", "Markdown summary copied to clipboard.", "success");
    } catch {
      pushToast("Could not copy", "Clipboard access was denied.", "danger");
    }
  };

  const handleSynthesize = async (overrideTemplate?: string) => {
    if (synthesizing) return;
    const chosenTemplate = overrideTemplate ?? template;
    setSynthError(null);
    if (!isTauri() || meeting.isDemo) {
      pushToast(
        "AI Summary verified",
        `${meeting.summary.groundedClaims}/${meeting.summary.totalClaims} claims grounded locally`,
        "success",
      );
      return;
    }
    setSynthesizing(true);
    setSynthProgress(5);
    try {
      const result = await synthesizeMeeting(meeting.id, chosenTemplate);
      if (result) {
        await onReload?.();
        setActiveTab("summary");
        pushToast(
          "AI Summary ready",
          `${result.report.keptItems} verified items generated locally`,
          "success",
        );
      }
    } catch (error) {
      const msg = formatHostError(error);
      setSynthError(msg);
      pushToast("Could not generate summary", msg, "danger");
    } finally {
      setSynthesizing(false);
      setSynthProgress(null);
    }
  };

  const handleTranscribe = async () => {
    if (transcribing || !isTauri() || meeting.isDemo) return;
    setTranscribing(true);
    try {
      const outcome = await transcribeMeeting(meeting.id);
      await onReload?.();
      pushToast(
        "Transcript ready",
        `${outcome.segments} ${pluralize(outcome.segments, "segment")} · ${outcome.speakerCount} ${pluralize(outcome.speakerCount, "speaker")}`,
        "success",
      );
    } catch (error) {
      pushToast("Transcription failed", formatHostError(error), "danger");
    } finally {
      setTranscribing(false);
    }
  };

  const handleSnapSlide = async () => {
    if (snapping) return;
    if (!isTauri() || meeting.isDemo) {
      pushToast("Slide captured", "Saved locally as WebP.", "success");
      return;
    }
    setSnapping(true);
    try {
      const outcome = await captureScreenshot(meeting.id);
      if (outcome?.deduplicated) {
        pushToast("Slide unchanged", outcome.reason, "default");
      } else {
        await onReload?.();
        pushToast("Slide captured", "Saved locally as WebP.", "success");
      }
    } catch (error) {
      pushToast("Could not capture slide", formatHostError(error), "danger");
    } finally {
      setSnapping(false);
    }
  };

  const toggleAction = async (action: ActionItem) => {
    const nextDone = !action.done;
    onMutate?.((curr) => ({
      ...curr,
      actions: curr.actions.map((item) =>
        item.id === action.id ? { ...item, done: nextDone, userEdited: true } : item,
      ),
    }));
    if (isTauri() && !meeting.isDemo) {
      try {
        await updateSynthesisItem(action.id, { isCompleted: nextDone });
      } catch (error) {
        onMutate?.((curr) => ({
          ...curr,
          actions: curr.actions.map((item) =>
            item.id === action.id ? { ...item, done: !nextDone } : item,
          ),
        }));
        pushToast("Could not update action", formatHostError(error), "danger");
      }
    }
  };

  const saveActionFields = async (
    actionId: string,
    patch: { content?: string; owner?: string; deadline?: string },
  ) => {
    const cleanOwner =
      patch.owner && patch.owner.toLowerCase() !== "unassigned" ? patch.owner : null;
    const cleanDeadline =
      patch.deadline && patch.deadline.toLowerCase() !== "not specified"
        ? patch.deadline
        : undefined;

    onMutate?.((curr) => ({
      ...curr,
      actions: curr.actions.map((item) =>
        item.id === actionId
          ? {
              ...item,
              task: patch.content ?? item.task,
              ownerLabel: cleanOwner,
              ownerId: undefined,
              deadline: cleanDeadline,
              userEdited: true,
            }
          : item,
      ),
    }));

    if (isTauri() && !meeting.isDemo) {
      try {
        await updateSynthesisItem(actionId, patch);
      } catch (error) {
        await onReload?.();
        pushToast("Could not update action", formatHostError(error), "danger");
      }
    }
  };

  const saveDecisionText = async (decisionId: string, nextText: string) => {
    onMutate?.((curr) => ({
      ...curr,
      decisions: curr.decisions.map((item) =>
        item.id === decisionId ? { ...item, text: nextText, userEdited: true } : item,
      ),
    }));
    if (isTauri() && !meeting.isDemo) {
      try {
        await updateSynthesisItem(decisionId, { content: nextText });
      } catch (error) {
        await onReload?.();
        pushToast("Could not update decision", formatHostError(error), "danger");
      }
    }
  };

  const handleUpdatedOcr = (screenshotId: string, text: string) => {
    onMutate?.((curr) => ({
      ...curr,
      screenshots: curr.screenshots.map((shot) =>
        shot.id === screenshotId
          ? { ...shot, ocrExtractedText: text, slideText: text || shot.slideText }
          : shot,
      ),
    }));
  };

  const handleDeletedScreenshot = (screenshotId: string) => {
    onMutate?.((curr) => ({
      ...curr,
      screenshots: curr.screenshots.filter((shot) => shot.id !== screenshotId),
    }));
  };

  const templateLabelByKey = new Map(
    (brand.synthesisTemplate?.sections ?? []).map((s) => [
      s.key
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, ""),
      s.label,
    ]),
  );

  const hasSavedAudio = Boolean(meeting.audioFilePath || meeting.systemAudioFilePath);
  const hasSummaryContent =
    meeting.summary.paragraphs.length > 0 ||
    meeting.decisions.length > 0 ||
    meeting.actions.length > 0;

  return (
    <AppShell
      rightMode="meeting"
      meeting={meeting}
      activeSpeakerId={activeSpeakerId}
      currentMs={currentMs}
      onReload={onReload}
      onMutate={onMutate}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Live Audio Bar at Top when Actively Recording */}
        {meeting.status === "recording" && (
          <AudioMeterHeader
            meeting={meeting}
            activeSpeakerId={activeSpeakerId}
            currentMs={currentMs}
            onReload={onReload}
          />
        )}

        {/* Main Scrollable Otter-Style Document Canvas */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[820px] px-6 pb-16 pt-7 sm:px-10">
            {/* 1. Large Editable Meeting Title */}
            <div className="flex items-start justify-between gap-3">
              {editingTitle ? (
                <input
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => void commitTitle()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (isImeComposing(event)) return;
                      void commitTitle();
                    } else if (event.key === "Escape") {
                      setTitleDraft(meeting.title);
                      setEditingTitle(false);
                    }
                  }}
                  aria-label="Meeting title"
                  autoFocus
                  className="glass-input h-11 w-full px-3.5 text-[24px] font-bold tracking-[-0.025em] text-text-primary outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingTitle(true)}
                  title="Click to rename meeting"
                  className="group flex min-w-0 items-center gap-2 rounded-xl py-0.5 text-left transition hover:opacity-90"
                >
                  <h1 className="text-[24px] font-bold leading-tight tracking-[-0.025em] text-text-primary sm:text-[28px]">
                    {meeting.title}
                  </h1>
                  <PencilLine
                    className="size-4 shrink-0 text-text-muted opacity-0 transition group-hover:opacity-100"
                    aria-hidden="true"
                  />
                </button>
              )}

              <div className="flex shrink-0 items-center gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => void toggleStar()}
                  aria-label={meeting.isStarred ? "Unstar meeting" : "Star meeting"}
                  aria-pressed={Boolean(meeting.isStarred)}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-xl transition",
                    meeting.isStarred
                      ? "text-amber-400"
                      : "text-text-muted hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary",
                  )}
                >
                  <Star
                    aria-hidden="true"
                    className={cn("size-4", meeting.isStarred && "fill-current")}
                  />
                </button>
              </div>
            </div>

            {/* 2. Otter-Style Metadata Row */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-muted">
              <span className="flex items-center gap-1.5 font-medium text-text-primary/90">
                <Avatar
                  name={meeting.participants[0]?.name || "Local"}
                  tone="accent"
                  size="xs"
                  className="size-4.5"
                />
                {meeting.participants[0]?.name || "Local Workspace"}
              </span>

              <span className="flex items-center gap-1.5">
                <Calendar className="size-3.5 opacity-75" aria-hidden="true" />
                {meeting.dateLabel}
              </span>

              <span className="flex items-center gap-1.5">
                <Clock className="size-3.5 opacity-75" aria-hidden="true" />
                {formatDuration(meeting.durationMs)}
              </span>

              <button
                type="button"
                onClick={() => setActiveTab("slides")}
                className="flex items-center gap-1.5 transition hover:text-text-primary"
              >
                <ImageIcon className="size-3.5 opacity-75" aria-hidden="true" />
                <span>
                  {meeting.screenshots.length} {pluralize(meeting.screenshots.length, "screenshot")}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleCopySummary()}
                className="flex items-center gap-1.5 font-medium text-text-primary/90 transition hover:text-accent-primary"
              >
                <Copy className="size-3.5" aria-hidden="true" />
                <span>Copy summary</span>
              </button>
            </div>

            {/* 3. Otter-Style Underline Tab Bar + Template Selector */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--glass-border)]">
              <div role="tablist" aria-label="Meeting sections" className="flex items-center gap-6">
                {(
                  [
                    { id: "summary", label: "Summary" },
                    { id: "notes", label: "My notes" },
                    {
                      id: "transcript",
                      label:
                        meeting.transcripts.length > 0
                          ? `Transcript (${meeting.transcripts.length})`
                          : "Transcript",
                    },
                    {
                      id: "slides",
                      label:
                        meeting.screenshots.length > 0
                          ? `Slides (${meeting.screenshots.length})`
                          : "Slides",
                    },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`${tabBaseId}-${tab.id}`}
                    aria-selected={activeTab === tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className="um-tab pb-3 text-[13.5px] font-semibold"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="mb-2 flex items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs text-text-muted">
                  <span>Template:</span>
                  <select
                    aria-label="Summary template"
                    value={template}
                    onChange={(e) => {
                      const next = e.target.value;
                      setTemplate(next);
                      if (
                        meeting.transcripts.length > 0 ||
                        meeting.notes.length > 0 ||
                        meeting.screenshots.length > 0
                      ) {
                        void handleSynthesize(next);
                      }
                    }}
                    className="bg-transparent font-semibold text-text-primary outline-none cursor-pointer"
                  >
                    {TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id} className="bg-bg-elevated text-text-primary">
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                <Button
                  variant="secondary"
                  size="xs"
                  disabled={synthesizing}
                  leading={<RefreshCw className={cn("size-3", synthesizing && "animate-spin")} />}
                  onClick={() => void handleSynthesize()}
                >
                  {synthesizing
                    ? synthProgress !== null
                      ? `${Math.round(synthProgress)}%`
                      : "Generating…"
                    : hasSummaryContent
                      ? "Regenerate"
                      : "Generate Summary"}
                </Button>
              </div>
            </div>

            {synthesizing && (
              <div className="mt-4">
                <ProgressBar
                  value={synthProgress ?? 15}
                  label="Generating on-device summary"
                  size="xs"
                  tone="accent"
                />
              </div>
            )}

            {synthError && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-recording-pulse/30 bg-recording-pulse/[0.08] px-4 py-3 text-xs text-recording-pulse">
                <span>{synthError}</span>
                <Link href="/models/" className={buttonClass({ variant: "secondary", size: "xs" })}>
                  Open AI Models
                </Link>
              </div>
            )}

            {/* TAB 1: SUMMARY & ACTION ITEMS (Otter Document Layout) */}
            {activeTab === "summary" && (
              <div
                role="tabpanel"
                aria-labelledby={`${tabBaseId}-summary`}
                className="mt-7 space-y-7"
              >
                {!hasSummaryContent && !meeting.isDemo ? (
                  <div className="panel flex flex-col items-center justify-center px-6 py-12 text-center">
                    <span className="flex size-12 items-center justify-center rounded-2xl border border-accent-primary/25 bg-accent-primary/12 text-accent-primary">
                      <Sparkles className="size-5" aria-hidden="true" />
                    </span>
                    <h2 className="mt-3.5 text-base font-semibold text-text-primary">
                      Generate your AI Meeting Summary
                    </h2>
                    <p className="mt-1.5 max-w-[440px] text-xs leading-5 text-text-muted">
                      {meeting.transcripts.length === 0 && hasSavedAudio
                        ? "First transcribe your recorded audio, then generate an Overview, Key Updates, Decisions, and Action Items."
                        : "Synthesize your transcript, notes, and slides into a structured overview and action items 100% offline."}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2.5">
                      {meeting.transcripts.length === 0 && hasSavedAudio && (
                        <Button
                          variant="secondary"
                          size="md"
                          disabled={transcribing}
                          leading={
                            transcribing ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <AudioLines className="size-4 text-accent-primary" />
                            )
                          }
                          onClick={() => void handleTranscribe()}
                        >
                          {transcribing ? "Transcribing…" : "1. Transcribe Audio"}
                        </Button>
                      )}
                      <Button
                        variant="primary"
                        size="md"
                        disabled={synthesizing}
                        leading={<Sparkles className="size-4" />}
                        onClick={() => void handleSynthesize()}
                      >
                        {synthesizing ? "Generating…" : "Generate Summary"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Overview Section */}
                    <section>
                      <h2 className="text-[18px] font-bold tracking-[-0.015em] text-text-primary">
                        Overview
                      </h2>
                      <p className="mt-2.5 text-[14.5px] leading-[1.7] text-text-primary/92">
                        {meeting.summary.headline}
                      </p>
                    </section>

                    {/* Key Updates / Summary Bullets Section */}
                    {meeting.summary.paragraphs.length > 0 && (
                      <section>
                        <h3 className="text-[15.5px] font-bold tracking-[-0.01em] text-text-primary">
                          Key Updates &amp; Discussion
                        </h3>
                        <ul className="mt-2.5 list-disc space-y-2.5 pl-5">
                          {meeting.summary.paragraphs.map((p) => (
                            <li
                              key={p.id}
                              className="pl-1 text-[14px] leading-[1.68] text-text-primary/92"
                            >
                              <span>{p.text}</span>
                              {p.evidence.length > 0 && (
                                <span
                                  onClick={() => setMeetingRightTab("assist")}
                                  className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle"
                                >
                                  <EvidenceChips meeting={meeting} evidence={p.evidence} />
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}

                    {/* Decisions / Status Section */}
                    {meeting.decisions.length > 0 && (
                      <section>
                        <h3 className="text-[15.5px] font-bold tracking-[-0.01em] text-text-primary">
                          Decisions &amp; Status
                        </h3>
                        <ul className="mt-2.5 list-disc space-y-2.5 pl-5">
                          {meeting.decisions.map((decision) => (
                            <EditableDecisionBullet
                              key={decision.id}
                              meeting={meeting}
                              decision={decision}
                              onSaveText={saveDecisionText}
                            />
                          ))}
                        </ul>
                      </section>
                    )}

                    {/* Custom Template Sections (e.g. Clinical SOAP) */}
                    {meeting.customSections?.map((section) => {
                      const resolvedLabel =
                        templateLabelByKey.get(section.itemType) ?? section.label;
                      return (
                        <section key={section.itemType}>
                          <h3 className="text-[15.5px] font-bold tracking-[-0.01em] text-text-primary">
                            {resolvedLabel}
                          </h3>
                          <ul className="mt-2.5 list-disc space-y-2 pl-5">
                            {section.items.map((item) => (
                              <li
                                key={item.id}
                                className="pl-1 text-[14px] leading-[1.68] text-text-primary/92"
                              >
                                <span>{item.text}</span>
                                {item.evidence.length > 0 && (
                                  <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle">
                                    <EvidenceChips meeting={meeting} evidence={item.evidence} />
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </section>
                      );
                    })}

                    {/* Otter-Style Interactive Follow-Up Prompt Pills */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {[
                        "Clarify key blockers and open questions",
                        "Summarize decisions and owners",
                        "Add next-step details",
                      ].map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          onClick={() => triggerAiPrompt(prompt)}
                          className="glass-subtle rounded-full px-3.5 py-1.5 text-xs font-medium text-text-primary transition hover:border-accent-primary/45 hover:bg-accent-primary/10"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>

                    {/* Action Items Section (Directly in Summary Document like Otter) */}
                    <section className="border-t border-[var(--glass-border)] pt-6">
                      <div className="mb-3 flex items-center justify-between">
                        <h2 className="text-[18px] font-bold tracking-[-0.015em] text-text-primary">
                          Action Items
                        </h2>
                        {meeting.actions.length > 0 && (
                          <Pill tone="accent">
                            {meeting.actions.filter((a) => a.done).length}/{meeting.actions.length}{" "}
                            completed
                          </Pill>
                        )}
                      </div>

                      {meeting.actions.length === 0 ? (
                        <p className="text-xs text-text-muted">
                          No action items extracted for this meeting yet.
                        </p>
                      ) : (
                        <div className="divide-y divide-[var(--glass-border)]">
                          {meeting.actions.map((action) => (
                            <OtterActionItemRow
                              key={action.id}
                              meeting={meeting}
                              action={action}
                              onToggle={() => void toggleAction(action)}
                              onSaveFields={(patch) => saveActionFields(action.id, patch)}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  </>
                )}
              </div>
            )}

            {/* TAB 2: MY NOTES */}
            {activeTab === "notes" && (
              <div
                role="tabpanel"
                aria-labelledby={`${tabBaseId}-notes`}
                className="panel mt-6 h-[560px] overflow-hidden"
              >
                <NotesEditor meeting={meeting} onMutate={onMutate} />
              </div>
            )}

            {/* TAB 3: TRANSCRIPT */}
            {activeTab === "transcript" && (
              <div
                role="tabpanel"
                aria-labelledby={`${tabBaseId}-transcript`}
                className="panel mt-6 min-h-[520px] overflow-hidden"
              >
                <TranscriptPane
                  meeting={meeting}
                  activeSegmentId={activeSegmentId}
                  onReload={onReload}
                  onMutate={onMutate}
                />
              </div>
            )}

            {/* TAB 4: SLIDES */}
            {activeTab === "slides" && (
              <div
                role="tabpanel"
                aria-labelledby={`${tabBaseId}-slides`}
                className="mt-6 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <p className="text-xs text-text-muted">
                    Captured presentation slides &amp; screen changes (deduplicated via dHash +
                    Apple Vision OCR)
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={snapping}
                    leading={
                      snapping ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Camera className="size-3.5 text-accent-secondary" />
                      )
                    }
                    onClick={() => void handleSnapSlide()}
                  >
                    Capture Slide Now
                  </Button>
                </div>

                {meeting.screenshots.length === 0 ? (
                  <div className="panel flex flex-col items-center justify-center px-6 py-14 text-center">
                    <Camera className="size-8 text-text-muted/50" aria-hidden="true" />
                    <p className="mt-3 text-sm font-semibold text-text-primary">
                      No slides captured yet
                    </p>
                    <p className="mt-1 max-w-xs text-xs text-text-muted">
                      Click Capture Slide Now or enable Smart Slide Capture when starting a
                      recording.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {meeting.screenshots.map((shot) => (
                      <ScreenshotCard
                        key={shot.id}
                        screenshot={shot}
                        onUpdatedOcr={handleUpdatedOcr}
                        onDeleted={handleDeletedScreenshot}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Audio Player Dock */}
        <TimelineDock meeting={meeting} onReload={onReload} />
      </div>
    </AppShell>
  );
}
