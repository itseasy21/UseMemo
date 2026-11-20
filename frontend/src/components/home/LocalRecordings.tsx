"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AudioLines,
  ChevronDown,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  Mic,
  SquareCheckBig,
  Star,
  Trash2,
} from "lucide-react";

import { Avatar, AvatarStack } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Pill } from "@/components/ui/Pill";
import { SlideThumbnail } from "@/components/ui/SlideThumbnail";
import { useAsrProgress, useMeetingChanged, useRecordingStopped } from "@/hooks/use-host-event";
import { MEETINGS, meetingHref, type Screenshot, type Speaker } from "@/lib/demo-data";
import { formatDuration, pluralize } from "@/lib/format";
import {
  deleteMeeting,
  listMeetings,
  listScreenshots,
  listSynthesis,
  listTranscript,
  setMeetingStarred,
  transcribeMeeting,
  type MeetingRecord,
} from "@/lib/host";
import { adaptScreenshotRecord } from "@/lib/meeting-adapter";
import { localDeviceNoun } from "@/lib/platform";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

type FeedCardData = {
  record: MeetingRecord;
  summaryExcerpt: string | null;
  actionCount: number;
  segmentCount: number;
  screenshots: Screenshot[];
  speakers: Speaker[];
};

const TONE_CYCLE: Array<Speaker["tone"]> = ["accent", "secondary", "warm", "violet"];

function formatDateGroupHeader(timestampMs: number): string {
  const date = new Date(timestampMs);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const itemStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((todayStart - itemStart) / 86_400_000);
  const monthDay = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  if (diffDays === 0) return `Today, ${monthDay}`;
  if (diffDays === 1) return `Yesterday, ${monthDay}`;
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTimeOfDay(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildDemoFeedCards(): FeedCardData[] {
  return MEETINGS.map((m, idx) => ({
    record: {
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
      folderId: `demo-folder-${m.folder.toLowerCase()}`,
      isStarred: idx === 0,
    },
    summaryExcerpt: m.summary.paragraphs.map((p) => p.text).join(" ") || m.summary.headline || null,
    actionCount: m.actions.length,
    segmentCount: m.transcripts.length,
    screenshots: m.screenshots,
    speakers: m.participants,
  }));
}

export function LocalRecordings() {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const openNewRecording = useWorkspaceStore((state) => state.openNewRecording);
  const activeFolderFilter = useWorkspaceStore((state) => state.activeFolderFilter);
  const setActiveFolderFilter = useWorkspaceStore((state) => state.setActiveFolderFilter);

  const [hosted, setHosted] = useState<boolean | null>(null);
  const [cards, setCards] = useState<FeedCardData[] | null>(null);
  const [feedFilter, setFeedFilter] = useState<"all" | "audio" | "starred">("all");
  const [deleteTarget, setDeleteTarget] = useState<MeetingRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [deviceNoun, setDeviceNoun] = useState("this Mac");

  useEffect(() => {
    setHosted(isTauri());
    setDeviceNoun(localDeviceNoun());
  }, []);

  const refreshFeed = useCallback(async () => {
    if (!isTauri()) {
      setCards(buildDemoFeedCards());
      return;
    }

    const rows = await listMeetings();
    if (!rows) {
      setCards([]);
      return;
    }

    const enriched = await Promise.all(
      rows.map(async (record): Promise<FeedCardData> => {
        const [synthRows, segRows, shotRows] = await Promise.all([
          listSynthesis(record.id),
          listTranscript(record.id),
          listScreenshots(record.id),
        ]);

        const synth = synthRows ?? [];
        const segs = segRows ?? [];
        const shots = shotRows ?? [];

        const summaryItems = synth.filter(
          (item) => item.itemType === "summary" || item.itemType === "decision",
        );
        const actionItems = synth.filter((item) => item.itemType === "action_item");

        let summaryExcerpt: string | null = null;
        if (summaryItems.length > 0) {
          summaryExcerpt = summaryItems.map((s) => s.content).join(" ");
        } else if (segs.length > 0) {
          summaryExcerpt = segs
            .slice(0, 4)
            .map((s) => s.text)
            .join(" ");
        } else if (record.manualNotesRawMd?.trim()) {
          summaryExcerpt = record.manualNotesRawMd.replace(/^[#>*-\s]+/gm, "").trim();
        }

        const uniqueSpeakerNames = Array.from(new Set(segs.map((s) => s.speakerLabel || "You")));
        const speakers: Speaker[] =
          uniqueSpeakerNames.length > 0
            ? uniqueSpeakerNames.map((name, idx) => ({
                id: `spk-${idx}`,
                name,
                role: name.toLowerCase() === "you" ? "Local mic" : "Participant",
                tone: TONE_CYCLE[idx % TONE_CYCLE.length],
              }))
            : [{ id: "you", name: "You", role: "Local mic", tone: "accent" }];

        const screenshots: Screenshot[] = shots.map((shot, idx) =>
          adaptScreenshotRecord(shot, idx),
        );

        return {
          record,
          summaryExcerpt,
          actionCount: actionItems.length,
          segmentCount: segs.length,
          screenshots,
          speakers,
        };
      }),
    );

    setCards(enriched);
  }, []);

  useEffect(() => {
    if (hosted === null) return;
    void refreshFeed();
  }, [hosted, refreshFeed]);

  useRecordingStopped(() => {
    void refreshFeed();
  });

  useMeetingChanged(() => {
    void refreshFeed();
  });

  useAsrProgress((payload) => {
    if (payload.meetingId !== transcribingId) return;
    setProgress(payload.percent);
  });

  const handleToggleStar = async (record: MeetingRecord) => {
    const next = !record.isStarred;
    setCards((curr) =>
      curr
        ? curr.map((c) =>
            c.record.id === record.id ? { ...c, record: { ...c.record, isStarred: next } } : c,
          )
        : curr,
    );
    if (hosted) {
      try {
        await setMeetingStarred(record.id, next);
      } catch (err) {
        await refreshFeed();
        pushToast("Could not update star", formatHostError(err), "danger");
      }
    }
  };

  const handleTranscribe = async (record: MeetingRecord) => {
    if (!hosted || transcribingId) return;
    setTranscribingId(record.id);
    setProgress(0);
    try {
      const outcome = await transcribeMeeting(record.id);
      await refreshFeed();
      pushToast(
        "Transcription complete",
        `${outcome.segments} ${pluralize(outcome.segments, "segment")} · ${outcome.speakerCount} ${pluralize(outcome.speakerCount, "speaker")}`,
        "success",
      );
    } catch (err) {
      pushToast("Transcription failed", formatHostError(err), "danger");
    } finally {
      setTranscribingId(null);
      setProgress(null);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return;
    if (!hosted) {
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await deleteMeeting(deleteTarget.id);
      setDeleteTarget(null);
      await refreshFeed();
      pushToast("Meeting deleted", "Removed audio, slides, and notes from local vault.", "default");
    } catch (err) {
      pushToast("Could not delete meeting", formatHostError(err), "danger");
    } finally {
      setDeleting(false);
    }
  };

  const visibleCards = useMemo(() => {
    if (!cards) return null;
    return cards.filter(({ record }) => {
      if (activeFolderFilter === "starred" && !record.isStarred) return false;
      if (
        activeFolderFilter !== "all" &&
        activeFolderFilter !== "starred" &&
        record.folderId !== activeFolderFilter
      ) {
        return false;
      }
      if (feedFilter === "starred" && !record.isStarred) return false;
      if (feedFilter === "audio" && !record.audioFilePath && record.durationMs <= 0) return false;
      return true;
    });
  }, [activeFolderFilter, cards, feedFilter]);

  const dateGroups = useMemo(() => {
    if (!visibleCards) return [];
    const groups: Array<{ label: string; items: FeedCardData[] }> = [];
    for (const item of visibleCards) {
      const label = formatDateGroupHeader(item.record.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) {
        last.items.push(item);
      } else {
        groups.push({ label, items: [item] });
      }
    }
    return groups;
  }, [visibleCards]);

  if (hosted === null) return null;

  return (
    <>
      <section aria-label="Conversations feed" className="space-y-6">
        {/* Top Filter Row */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {activeFolderFilter !== "all" && (
              <button
                type="button"
                onClick={() => setActiveFolderFilter("all")}
                className="glass-subtle inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-accent-primary"
              >
                <span>
                  Filter: {activeFolderFilter === "starred" ? "Starred" : "Selected Folder"}
                </span>
                <span>×</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-xs">
            {(
              [
                { id: "all", label: "For you" },
                { id: "audio", label: "With audio" },
                { id: "starred", label: "Starred" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setFeedFilter(opt.id)}
                className={cn(
                  "rounded-full px-3 py-1 font-medium transition",
                  feedFilter === opt.id
                    ? "bg-accent-primary/14 text-accent-primary"
                    : "text-text-muted hover:text-text-primary",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Empty State */}
        {visibleCards !== null && visibleCards.length === 0 && (
          <div className="panel flex flex-col items-center justify-center px-6 py-16 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl border border-accent-primary/25 bg-accent-primary/12 text-accent-primary">
              <Mic className="size-6" aria-hidden="true" />
            </span>
            <h2 className="mt-4 text-base font-semibold text-text-primary">
              No conversations in this view
            </h2>
            <p className="mt-1.5 max-w-[400px] text-xs leading-5 text-text-muted">
              Record a meeting or voice note to get automatic transcripts, slide captures, and
              grounded AI summaries.
            </p>
            <Button
              variant="primary"
              size="md"
              className="mt-5 rounded-full"
              leading={<Mic className="size-4" />}
              onClick={openNewRecording}
            >
              Start Recording
            </Button>
          </div>
        )}

        {/* Chronological Date-Grouped Otter Feed */}
        {dateGroups.map((group) => (
          <div key={group.label} className="space-y-3.5">
            <div className="flex items-center gap-1.5 px-1 text-xs font-semibold text-text-muted">
              <span>{group.label}</span>
              <ChevronDown className="size-3.5 opacity-70" aria-hidden="true" />
            </div>

            <div className="space-y-3.5">
              {group.items.map((card) => {
                const { record, summaryExcerpt, actionCount, segmentCount, screenshots, speakers } =
                  card;
                const isTranscribing = transcribingId === record.id;
                const hasRichBody =
                  Boolean(summaryExcerpt) ||
                  screenshots.length > 0 ||
                  actionCount > 0 ||
                  segmentCount > 0;

                return (
                  <div key={record.id} className="flex items-start gap-3.5">
                    {/* Left Speaker/Owner Avatar (Otter feed style) */}
                    <div className="mt-2 hidden shrink-0 sm:block">
                      <Avatar
                        name={speakers[0]?.name || record.title}
                        tone={speakers[0]?.tone || "accent"}
                        size="md"
                      />
                    </div>

                    {/* Main Feed Card */}
                    <article className="um-feed-card panel min-w-0 flex-1 p-4 sm:p-5">
                      <header className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-[16.5px] font-semibold tracking-[-0.015em] text-text-primary">
                              <Link href={meetingHref(record.id)} className="card-link">
                                {record.title}
                              </Link>
                            </h3>
                            {record.status === "recording" && (
                              <Pill
                                tone="danger"
                                icon={
                                  <span className="size-1.5 animate-pulse rounded-full bg-recording-pulse" />
                                }
                              >
                                Live
                              </Pill>
                            )}
                          </div>
                          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
                            <span>{formatTimeOfDay(record.createdAt)}</span>
                            <span>·</span>
                            <span>{formatDuration(Math.max(0, record.durationMs))}</span>
                            <span>·</span>
                            <span>Local Vault</span>
                          </p>
                        </div>

                        {/* Independent Card Actions */}
                        <div className="flex shrink-0 items-center gap-1">
                          {hosted &&
                            record.audioFilePath &&
                            segmentCount === 0 &&
                            record.status !== "recording" && (
                              <Button
                                variant="secondary"
                                size="xs"
                                disabled={isTranscribing}
                                leading={
                                  isTranscribing ? (
                                    <Loader2 className="size-3 animate-spin" />
                                  ) : (
                                    <AudioLines className="size-3 text-accent-primary" />
                                  )
                                }
                                onClick={() => void handleTranscribe(record)}
                              >
                                {isTranscribing
                                  ? progress !== null
                                    ? `${Math.round(progress)}%`
                                    : "Transcribing…"
                                  : "Transcribe"}
                              </Button>
                            )}

                          <button
                            type="button"
                            onClick={() => void handleToggleStar(record)}
                            aria-label={
                              record.isStarred ? `Unstar ${record.title}` : `Star ${record.title}`
                            }
                            aria-pressed={record.isStarred}
                            className={cn(
                              "flex size-7 items-center justify-center rounded-lg transition",
                              record.isStarred
                                ? "text-amber-400"
                                : "text-text-muted/50 hover:bg-[var(--glass-surface-subtle)] hover:text-text-primary",
                            )}
                          >
                            <Star
                              aria-hidden="true"
                              className={cn("size-3.5", record.isStarred && "fill-current")}
                            />
                          </button>

                          {hosted && (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(record)}
                              aria-label={`Delete ${record.title}`}
                              title="Delete meeting"
                              className="flex size-7 items-center justify-center rounded-lg text-text-muted/50 transition hover:bg-recording-pulse/10 hover:text-recording-pulse"
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </header>

                      {/* Summary / Transcript Preview Paragraph */}
                      {summaryExcerpt && (
                        <div className="mt-3">
                          <p className="line-clamp-3 text-[13.5px] leading-[1.6] text-text-primary/88">
                            {summaryExcerpt}
                          </p>
                          <span className="mt-1 inline-block text-xs font-medium text-text-muted">
                            Show more
                          </span>
                        </div>
                      )}

                      {/* Horizontal Slide Thumbnail Strip (Otter Feed Style) */}
                      {screenshots.length > 0 && (
                        <div className="mt-3.5 flex gap-2.5 overflow-x-auto pb-1">
                          {screenshots.slice(0, 3).map((shot) => (
                            <div
                              key={shot.id}
                              className="w-[200px] shrink-0 overflow-hidden rounded-xl border border-[var(--glass-border)]"
                            >
                              <SlideThumbnail
                                screenshot={shot}
                                showTime
                                className="rounded-none border-0"
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Footer: Speaker Avatars + Action Item & Screenshot Count Badges */}
                      {hasRichBody && (
                        <footer className="mt-3.5 flex items-center justify-between gap-3 pt-1">
                          <AvatarStack people={speakers} size="xs" max={4} />

                          <div className="flex items-center gap-1.5">
                            {actionCount > 0 && (
                              <span
                                title={`${actionCount} action items`}
                                className="glass-subtle tabular inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-text-muted"
                              >
                                <SquareCheckBig
                                  className="size-3.5 text-accent-primary"
                                  aria-hidden="true"
                                />
                                {actionCount}
                              </span>
                            )}
                            {screenshots.length > 0 && (
                              <span
                                title={`${screenshots.length} slide screenshots`}
                                className="glass-subtle tabular inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-text-muted"
                              >
                                <ImageIcon
                                  className="size-3.5 text-accent-secondary"
                                  aria-hidden="true"
                                />
                                {screenshots.length}
                              </span>
                            )}
                            {segmentCount > 0 && actionCount === 0 && (
                              <span
                                title={`${segmentCount} transcript segments`}
                                className="glass-subtle tabular inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-text-muted"
                              >
                                <MessageSquareText className="size-3.5" aria-hidden="true" />
                                {segmentCount}
                              </span>
                            )}
                          </div>
                        </footer>
                      )}
                    </article>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete this conversation permanently?"
        description={`"${deleteTarget?.title ?? "This conversation"}" and its local audio, slide snapshots, transcript, and AI summary will be permanently removed from ${deviceNoun}.`}
        size="sm"
        footer={
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" autoFocus onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleting}
              onClick={() => void handleDeleteConfirmed()}
            >
              {deleting ? "Deleting…" : "Delete permanently"}
            </Button>
          </div>
        }
      >
        <p className="text-xs leading-5 text-text-muted">
          Because your vault is 100% local, deleted recordings cannot be recovered from any cloud
          backup.
        </p>
      </Dialog>
    </>
  );
}
