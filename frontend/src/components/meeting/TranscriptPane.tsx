"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AudioLines,
  ChevronDown,
  Loader2,
  PencilLine,
  Radio,
  RotateCcw,
  UserRound,
} from "lucide-react";

import { ScreenshotCard } from "@/components/meeting/ScreenshotCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button, buttonClass } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Popover } from "@/components/ui/Popover";
import { useBrand } from "@/components/providers/BrandProvider";
import { useAsrProgress } from "@/hooks/use-host-event";
import {
  getScreenshot,
  getSpeaker,
  type Meeting,
  type Speaker,
  type TranscriptSegment,
} from "@/lib/demo-data";
import { formatTimestamp, pluralize } from "@/lib/format";
import {
  cancelTranscription,
  renameSpeaker,
  transcribeMeeting,
  updateTranscriptSegment,
} from "@/lib/host";
import { isImeComposing } from "@/lib/ime";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player";
import { speakerLabel, useWorkspaceStore } from "@/stores/workspace";

function SpeakerPill({
  meeting,
  speaker,
  segment,
  onRenamed,
}: {
  meeting: Meeting;
  speaker: Speaker;
  segment: TranscriptSegment;
  onRenamed?: () => Promise<void>;
}) {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const labels = useWorkspaceStore((state) => state.speakerLabels);
  const setSpeakerLabel = useWorkspaceStore((state) => state.setSpeakerLabel);
  const resetSpeakerLabel = useWorkspaceStore((state) => state.resetSpeakerLabel);
  const label = speakerLabel(labels, meeting.id, speaker.id, speaker.name);
  const brand = useBrand();
  const [draft, setDraft] = useState(label);
  const [saveVoiceprint, setSaveVoiceprint] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(label);
  }, [label]);

  const handleSubmit = async (close: () => void) => {
    const next = draft.trim();
    if (!next) return;

    if (!isTauri() || meeting.isDemo) {
      if (next !== speaker.name) {
        setSpeakerLabel(meeting.id, speaker.id, next);
      } else {
        resetSpeakerLabel(meeting.id, speaker.id);
      }
      close();
      return;
    }

    setSaving(true);
    try {
      const oldLabel = segment.speakerLabelRaw || speaker.name;
      await renameSpeaker(meeting.id, oldLabel, next, saveVoiceprint);
      setSpeakerLabel(meeting.id, speaker.id, next);
      await onRenamed?.();
      pushToast(
        `Renamed speaker to ${next}`,
        saveVoiceprint
          ? "Updated in SQLite and enrolled local voiceprint."
          : "Updated across meeting transcript segments.",
        "success",
      );
      close();
    } catch (error) {
      pushToast("Could not rename speaker", formatHostError(error), "danger");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      label={`Rename speaker ${label}`}
      align="start"
      panelClassName="w-[248px]"
      trigger={(props) => (
        <button
          {...props}
          title="Rename speaker"
          className={cn(
            "inline-flex min-h-6 max-w-[190px] items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition hover:brightness-110",
            speaker.tone === "accent" &&
              "border-accent-primary/30 bg-accent-primary/12 text-accent-primary",
            speaker.tone === "secondary" &&
              "border-accent-secondary/30 bg-accent-secondary/12 text-accent-secondary",
            speaker.tone === "warm" &&
              "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300",
            speaker.tone === "violet" &&
              "border-violet-500/30 bg-violet-500/12 text-violet-700 dark:text-violet-300",
          )}
        >
          <Avatar name={label} tone={speaker.tone} size="xs" className="size-4 text-[9px]" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 opacity-65" aria-hidden="true" />
        </button>
      )}
    >
      {(close) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit(close);
          }}
        >
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
            <UserRound className="size-3.5 text-text-muted" aria-hidden="true" />
            Speaker name
          </p>
          <p className="mb-2 text-[11px] leading-4 text-text-muted">
            Detected as {segment.speakerLabelRaw || speaker.name}
          </p>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isImeComposing(event)) {
                event.preventDefault();
              }
            }}
            autoFocus
            aria-label="Speaker name"
            className="glass-input h-8 w-full px-2.5 text-xs text-text-primary outline-none focus:border-accent-primary/50"
          />
          {brand.features.enableVoiceprintEnrollment && !meeting.isDemo && (
            <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={saveVoiceprint}
                onChange={(e) => setSaveVoiceprint(e.target.checked)}
                className="rounded accent-[var(--brand-accent-primary)]"
              />
              Remember voiceprint on this device
            </label>
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                resetSpeakerLabel(meeting.id, speaker.id);
                setDraft(speaker.name);
                close();
              }}
              className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition hover:text-text-primary"
            >
              <RotateCcw className="size-3" aria-hidden="true" /> Reset
            </button>
            <Button type="submit" variant="primary" size="xs" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </Popover>
  );
}

function SegmentCard({
  meeting,
  segment,
  active,
  showSpeakerHeader,
  isLatestLive,
  onReload,
  onMutate,
}: {
  meeting: Meeting;
  segment: TranscriptSegment;
  active: boolean;
  showSpeakerHeader: boolean;
  isLatestLive: boolean;
  onReload?: () => Promise<void>;
  onMutate?: (updater: (current: Meeting) => Meeting) => void;
}) {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const seek = usePlayerStore((state) => state.seek);
  const speaker = getSpeaker(meeting, segment.speakerId);
  const screenshot = segment.screenshotId
    ? getScreenshot(meeting, segment.screenshotId)
    : undefined;

  const [editing, setEditing] = useState(false);
  const [textDraft, setTextDraft] = useState(
    segment.confirmedText || segment.unconfirmedText || "",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTextDraft(segment.confirmedText || segment.unconfirmedText || "");
  }, [segment.confirmedText, segment.unconfirmedText]);

  const commitText = async () => {
    const trimmed = textDraft.trim();
    if (!trimmed) {
      setEditing(false);
      setTextDraft(segment.confirmedText);
      return;
    }
    if (trimmed === segment.confirmedText) {
      setEditing(false);
      return;
    }

    onMutate?.((curr) => ({
      ...curr,
      transcripts: curr.transcripts.map((item) =>
        item.id === segment.id
          ? { ...item, confirmedText: trimmed, unconfirmedText: undefined, live: false }
          : item,
      ),
    }));

    if (isTauri() && !meeting.isDemo) {
      setSaving(true);
      try {
        await updateTranscriptSegment(segment.id, { text: trimmed });
        setEditing(false);
      } catch (error) {
        pushToast("Could not update transcript line", formatHostError(error), "danger");
      } finally {
        setSaving(false);
      }
    } else {
      setEditing(false);
    }
  };

  return (
    <article
      id={`transcript-${segment.id}`}
      className={cn(
        "group relative scroll-mt-4 rounded-xl border border-transparent px-3 py-1.5 transition-all",
        showSpeakerHeader && "mt-2.5 pt-2.5",
        active
          ? "border-accent-primary/25 bg-accent-primary/[0.07] shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_10%,transparent)]"
          : "hover:bg-[var(--glass-surface-subtle)]",
      )}
    >
      {showSpeakerHeader && (
        <div className="mb-1.5 flex items-center gap-2 pl-12">
          <SpeakerPill meeting={meeting} speaker={speaker} segment={segment} onRenamed={onReload} />
          {isLatestLive && (
            <Pill
              tone="danger"
              className="gap-1 px-2 py-0"
              icon={<span className="size-1.5 animate-pulse rounded-full bg-recording-pulse" />}
            >
              Live
            </Pill>
          )}
        </div>
      )}

      <div className="flex items-start gap-2.5">
        <button
          type="button"
          onClick={() => seek(segment.startMs)}
          aria-label={`Seek to ${formatTimestamp(segment.startMs)}`}
          title="Seek to timestamp"
          className={cn(
            "tabular mt-0.5 w-10 shrink-0 rounded px-1 py-0.5 text-right text-[11px] transition hover:bg-[var(--glass-surface)] hover:text-text-primary",
            active
              ? "font-medium text-accent-primary"
              : "text-text-muted/70 opacity-75 group-hover:opacity-100",
          )}
        >
          {formatTimestamp(segment.startMs)}
        </button>

        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-1.5">
              <textarea
                value={textDraft}
                onChange={(e) => setTextDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (isImeComposing(e)) return;
                    void commitText();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setTextDraft(segment.confirmedText);
                    setEditing(false);
                  }
                }}
                rows={2}
                aria-label="Edit transcript segment"
                autoFocus
                className="glass-input w-full p-2.5 text-[13px] leading-5 text-text-primary outline-none focus:border-accent-primary/50"
              />
              <div className="flex justify-end gap-1.5">
                <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="xs"
                  disabled={saving}
                  onClick={() => void commitText()}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-2">
              <p className="flex-1 text-[13.5px] leading-[1.65] text-text-primary/92">
                {segment.confirmedText}
                {segment.unconfirmedText && (
                  <span className="ml-1 italic text-text-muted/75">{segment.unconfirmedText}</span>
                )}
                {isLatestLive && (
                  <span className="ml-1 inline-block h-3.5 w-[2px] animate-pulse bg-accent-primary align-middle" />
                )}
              </p>
              {!segment.live && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  aria-label={`Edit transcript at ${formatTimestamp(segment.startMs)}`}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-text-muted opacity-0 transition hover:bg-[var(--glass-surface)] hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <PencilLine className="size-3" aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {screenshot && (
            <ScreenshotCard
              screenshot={screenshot}
              className="mt-2.5"
              onUpdatedOcr={(id, text) => {
                onMutate?.((curr) => ({
                  ...curr,
                  screenshots: curr.screenshots.map((shot) =>
                    shot.id === id ? { ...shot, ocrExtractedText: text, slideText: text } : shot,
                  ),
                }));
              }}
              onDeleted={(id) => {
                onMutate?.((curr) => ({
                  ...curr,
                  screenshots: curr.screenshots.filter((shot) => shot.id !== id),
                }));
              }}
            />
          )}
        </div>
      </div>
    </article>
  );
}

export function TranscriptPane({
  meeting,
  activeSegmentId,
  onReload,
  onMutate,
}: {
  meeting: Meeting;
  activeSegmentId: string | null;
  onReload?: () => Promise<void>;
  onMutate?: (updater: (current: Meeting) => Meeting) => void;
}) {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const [follow, setFollow] = useState(true);
  const [transcribing, setTranscribing] = useState(false);
  const [asrProgress, setAsrProgress] = useState<number | null>(null);
  const [asrError, setAsrError] = useState<string | null>(null);

  useEffect(() => {
    if (!follow || !isPlaying || !activeSegmentId) return;
    const element = document.getElementById(`transcript-${activeSegmentId}`);
    element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSegmentId, follow, isPlaying]);

  useAsrProgress((payload) => {
    if (payload.meetingId !== meeting.id) return;
    setAsrProgress(payload.percent);
    if (payload.stage === "complete" || payload.stage === "failed") {
      setTranscribing(false);
    }
  });

  const runTranscription = async () => {
    if (transcribing || !isTauri() || meeting.isDemo) return;
    setTranscribing(true);
    setAsrProgress(0);
    setAsrError(null);
    try {
      const outcome = await transcribeMeeting(meeting.id);
      await onReload?.();
      pushToast(
        "Transcription ready",
        `${outcome.segments} ${pluralize(outcome.segments, "segment")} · ${outcome.speakerCount} ${pluralize(outcome.speakerCount, "speaker")}`,
        "success",
      );
    } catch (error) {
      const msg = formatHostError(error);
      setAsrError(msg);
      pushToast("Transcription failed", msg, "danger");
    } finally {
      setTranscribing(false);
      setAsrProgress(null);
    }
  };

  const speakerCount =
    new Set(meeting.transcripts.map((segment) => segment.speakerId)).size ||
    meeting.participants.length;
  const hasSavedAudio = Boolean(meeting.audioFilePath || meeting.systemAudioFilePath);
  const canTranscribe =
    isTauri() &&
    !meeting.isDemo &&
    hasSavedAudio &&
    meeting.status !== "recording" &&
    !transcribing;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--glass-border)] px-4 text-xs text-text-muted">
        <Radio className="size-3.5 text-accent-primary" aria-hidden="true" />
        <span className="font-semibold text-text-primary">Transcript</span>
        <span className="opacity-40">·</span>
        <span>
          {meeting.transcripts.length} {pluralize(meeting.transcripts.length, "segment")} ·{" "}
          {speakerCount} {pluralize(speakerCount, "speaker")}
        </span>
        {canTranscribe && meeting.transcripts.length > 0 && (
          <button
            type="button"
            onClick={() => void runTranscription()}
            className="glass-subtle inline-flex h-6.5 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-text-primary transition hover:border-accent-primary/40"
          >
            <AudioLines className="size-3 text-accent-primary" aria-hidden="true" />
            Re-transcribe
          </button>
        )}
        <button
          type="button"
          onClick={() => setFollow((value) => !value)}
          aria-pressed={follow}
          className={cn(
            "ml-auto inline-flex h-6.5 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition",
            follow
              ? "border-accent-primary/30 bg-accent-primary/12 text-accent-primary"
              : "border-[var(--glass-border)] text-text-muted hover:text-text-primary",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              follow ? "bg-accent-primary" : "bg-text-muted/40",
            )}
          />
          Auto-scroll
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {transcribing && (
          <div className="glass-subtle mb-3 flex items-center gap-2.5 rounded-xl border-accent-primary/30 px-3.5 py-2.5 text-xs text-text-primary">
            <Loader2
              className="size-4 shrink-0 animate-spin text-accent-primary"
              aria-hidden="true"
            />
            <span className="flex-1">
              Transcribing audio on-device
              {asrProgress !== null ? ` (${Math.round(asrProgress)}%)` : ""}…
            </span>
            <Button variant="ghost" size="xs" onClick={() => void cancelTranscription()}>
              Cancel
            </Button>
          </div>
        )}

        {asrError && (
          <div className="mb-3 rounded-xl border border-recording-pulse/30 bg-recording-pulse/[0.08] p-3.5 text-xs text-recording-pulse">
            <p className="font-medium">Transcription could not run</p>
            <p className="mt-1 text-text-muted">{asrError}</p>
            <div className="mt-2">
              <Link href="/models/" className={buttonClass({ variant: "secondary", size: "xs" })}>
                Open AI Models
              </Link>
            </div>
          </div>
        )}

        {meeting.transcripts.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl border border-accent-primary/25 bg-accent-primary/10 text-accent-primary">
              <AudioLines className="size-5" aria-hidden="true" />
            </span>
            <p className="mt-3.5 text-sm font-semibold text-text-primary">
              {meeting.status === "recording"
                ? "Listening for speech…"
                : hasSavedAudio
                  ? "Ready to transcribe"
                  : "No audio recorded yet"}
            </p>
            <p className="mt-1 max-w-xs text-xs leading-5 text-text-muted">
              {meeting.status === "recording"
                ? "Live captions appear automatically every few seconds as you speak."
                : hasSavedAudio
                  ? "Run on-device voice recognition to generate a speaker-labeled transcript."
                  : "Take notes on the left or start a recording."}
            </p>
            {canTranscribe && (
              <Button
                variant="primary"
                size="md"
                className="mt-4"
                leading={<AudioLines className="size-4" />}
                onClick={() => void runTranscription()}
              >
                Transcribe Recording
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-0.5">
            {meeting.transcripts.map((segment, idx) => {
              const prev = idx > 0 ? meeting.transcripts[idx - 1] : null;
              const showSpeakerHeader = !prev || prev.speakerId !== segment.speakerId;
              const isLatestLive = Boolean(segment.live && idx === meeting.transcripts.length - 1);
              return (
                <SegmentCard
                  key={segment.id}
                  meeting={meeting}
                  segment={segment}
                  active={activeSegmentId === segment.id}
                  showSpeakerHeader={showSpeakerHeader}
                  isLatestLive={isLatestLive}
                  onReload={onReload}
                  onMutate={onMutate}
                />
              );
            })}
          </div>
        )}

        {meeting.screenshots.length > 0 && meeting.transcripts.length === 0 && (
          <div className="mt-4 space-y-2.5 border-t border-[var(--glass-border)] pt-3.5">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
              Captured slides ({meeting.screenshots.length})
            </p>
            {meeting.screenshots.map((shot) => (
              <ScreenshotCard
                key={shot.id}
                screenshot={shot}
                onUpdatedOcr={(id, text) => {
                  onMutate?.((curr) => ({
                    ...curr,
                    screenshots: curr.screenshots.map((s) =>
                      s.id === id ? { ...s, ocrExtractedText: text, slideText: text } : s,
                    ),
                  }));
                }}
                onDeleted={(id) => {
                  onMutate?.((curr) => ({
                    ...curr,
                    screenshots: curr.screenshots.filter((s) => s.id !== id),
                  }));
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
