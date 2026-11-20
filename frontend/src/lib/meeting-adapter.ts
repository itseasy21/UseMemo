/**
 * Adapter mapping normalized SQLite vault records into the rich `Meeting`
 * studio and synthesis view-model without losing real file paths, IDs, or
 * verifier-grounded evidence links.
 */

import type {
  ActionItem,
  CustomSynthesisSection,
  Decision,
  EvidenceRef,
  Meeting,
  NoteKind,
  NoteLine,
  Screenshot,
  SlidePalette,
  Speaker,
  SpeakerTone,
  SynthesisSummary,
  TranscriptSegment,
} from "@/lib/demo-data";
import type {
  FolderRecord,
  MeetingRecord,
  NoteBlockRecord,
  ScreenshotRecord,
  SpeakerRecord,
  SynthesisItemRecord,
  TranscriptSegmentRecord,
} from "@/lib/host";
import { toAssetUrl } from "@/lib/tauri";

const SPEAKER_TONES: SpeakerTone[] = ["accent", "secondary", "warm", "violet"];
const SLIDE_PALETTES: SlidePalette[] = ["emerald", "indigo", "amber", "violet", "slate"];

function formatEvidenceTimestamp(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDateLabel(createdAtMs: number): string {
  const date = new Date(createdAtMs);
  if (!Number.isFinite(date.getTime())) return "Local recording";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const timePart = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today · ${timePart}`;
  const datePart = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${datePart} · ${timePart}`;
}

function mapBlockKind(blockType: string, content: string): NoteKind {
  const normalized = blockType.toLowerCase();
  if (normalized === "heading" || /^#{1,3}\s+/.test(content)) return "heading";
  if (normalized === "decision" || /^\s*(?:>\s*)?(?:\*\*)?decision\b/i.test(content)) {
    return "decision";
  }
  if (normalized === "todo" || /^\s*(?:\*\*)?todo\b/i.test(content)) return "todo";
  if (normalized === "bookmark" || /^\s*(?:\*\*)?bookmark\b/i.test(content)) return "bookmark";
  return "note";
}

function cleanBlockText(contentMd: string): string {
  return contentMd
    .replace(/^#{1,3}\s+/, "")
    .replace(/^>\s*/, "")
    .trim();
}

function speakerSlug(label: string): string {
  const trimmed = label.trim().toLowerCase();
  if (!trimmed) return "speaker";
  return trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "speaker";
}

export function adaptScreenshotRecord(record: ScreenshotRecord, index = 0): Screenshot {
  const ocr = record.ocrExtractedText?.trim() ?? "";
  const firstLine = ocr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const trigger: Screenshot["trigger"] =
    record.captureTrigger === "manual"
      ? "manual"
      : record.captureTrigger === "slide-change"
        ? "slide-change"
        : "interval";

  return {
    id: record.id,
    startMs: record.startMs,
    endMs: record.endMs,
    title: firstLine ? firstLine.slice(0, 56) : `Slide ${index + 1}`,
    caption: `${record.width}×${record.height}`,
    slideText: ocr || "Captured frame stored locally as WebP.",
    palette: SLIDE_PALETTES[index % SLIDE_PALETTES.length],
    trigger,
    filePath: record.filePath,
    assetUrl: toAssetUrl(record.filePath),
    width: record.width,
    height: record.height,
    dhash: record.dhash,
    ocrExtractedText: record.ocrExtractedText,
  };
}

export type VaultMeetingBundle = {
  meeting: MeetingRecord;
  notes: NoteBlockRecord[];
  transcript: TranscriptSegmentRecord[];
  screenshots: ScreenshotRecord[];
  synthesis: SynthesisItemRecord[];
  speakers: SpeakerRecord[];
  folders: FolderRecord[];
  tags: string[];
};

export function parseEvidenceRefs(
  evidenceRefsJson: string,
  notes: NoteBlockRecord[],
  transcript: TranscriptSegmentRecord[],
  screenshots: ScreenshotRecord[],
): EvidenceRef[] {
  let rawRefs: unknown = [];
  try {
    rawRefs = JSON.parse(evidenceRefsJson);
  } catch {
    rawRefs = [];
  }
  if (!Array.isArray(rawRefs)) return [];

  const transcriptByStamp = new Map<string, TranscriptSegmentRecord[]>();
  const transcriptBySeq = new Map<number, TranscriptSegmentRecord>();
  for (const seg of transcript) {
    const stamp = `T-${formatEvidenceTimestamp(seg.startMs)}`;
    const list = transcriptByStamp.get(stamp) ?? [];
    list.push(seg);
    transcriptByStamp.set(stamp, list);
    transcriptBySeq.set(seg.seqNo, seg);
  }

  const noteByLine = new Map<number, NoteBlockRecord>();
  for (const note of notes) {
    noteByLine.set(note.lineIndex, note);
  }

  const screenshotByStamp = new Map<string, ScreenshotRecord>();
  for (const shot of screenshots) {
    const stamp = `S-${formatEvidenceTimestamp(shot.startMs)}`;
    if (!screenshotByStamp.has(stamp)) {
      screenshotByStamp.set(stamp, shot);
    }
  }

  const resolved: EvidenceRef[] = [];
  const seen = new Set<string>();

  for (const entry of rawRefs) {
    if (typeof entry !== "string") continue;
    const tag = entry
      .trim()
      .replace(/^\[|\]$/g, "")
      .toUpperCase();
    if (!tag) continue;

    if (tag.startsWith("N-L")) {
      const lineNo = Number(tag.slice(3));
      const matched = Number.isFinite(lineNo) ? noteByLine.get(lineNo) : undefined;
      if (matched) {
        const key = `note:${matched.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          resolved.push({ kind: "note", id: matched.id, rawTag: tag });
        }
      }
      continue;
    }

    if (tag.startsWith("T-")) {
      const hashIndex = tag.indexOf("#");
      const baseTag = hashIndex >= 0 ? tag.slice(0, hashIndex) : tag;
      const seqHint = hashIndex >= 0 ? Number(tag.slice(hashIndex + 1)) : NaN;
      const matched =
        (Number.isFinite(seqHint) ? transcriptBySeq.get(seqHint) : undefined) ??
        transcriptByStamp.get(baseTag)?.[0];
      if (matched) {
        const key = `transcript:${matched.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          resolved.push({ kind: "transcript", id: matched.id, rawTag: tag });
        }
      }
      continue;
    }

    if (tag.startsWith("S-")) {
      const matched = screenshotByStamp.get(tag);
      if (matched) {
        const key = `screenshot:${matched.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          resolved.push({ kind: "screenshot", id: matched.id, rawTag: tag });
        }
      }
    }
  }

  return resolved;
}

function humanizeSectionType(itemType: string): string {
  return itemType.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function adaptSynthesisRecords(
  meetingTitle: string,
  items: SynthesisItemRecord[],
  notes: NoteBlockRecord[],
  transcript: TranscriptSegmentRecord[],
  screenshots: ScreenshotRecord[],
  participants: Speaker[],
): {
  summary: SynthesisSummary;
  decisions: Decision[];
  actions: ActionItem[];
  customSections: CustomSynthesisSection[];
} {
  const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  const summaryRows = sorted.filter((item) => item.itemType === "summary");
  const decisionRows = sorted.filter((item) => item.itemType === "decision");
  const actionRows = sorted.filter(
    (item) => item.itemType === "action_item" || item.itemType === "action",
  );
  const customRows = sorted.filter(
    (item) =>
      item.itemType !== "summary" &&
      item.itemType !== "decision" &&
      item.itemType !== "action_item" &&
      item.itemType !== "action",
  );

  const paragraphs = summaryRows.map((row) => ({
    id: row.id,
    text: row.content,
    userEdited: row.isUserEdited,
    evidence: parseEvidenceRefs(row.evidenceRefsJson, notes, transcript, screenshots),
  }));

  const decisions: Decision[] = decisionRows.map((row) => ({
    id: row.id,
    text: row.content,
    rationale: row.rationale,
    userEdited: row.isUserEdited,
    evidence: parseEvidenceRefs(row.evidenceRefsJson, notes, transcript, screenshots),
  }));

  const actions: ActionItem[] = actionRows.map((row) => {
    const rawOwner = row.owner?.trim() ?? "";
    const isUnassigned = !rawOwner || rawOwner.toLowerCase() === "unassigned";
    const matchedSpeaker = isUnassigned
      ? undefined
      : participants.find((speaker) => speaker.name.toLowerCase() === rawOwner.toLowerCase());
    const rawDeadline = row.deadline?.trim() ?? "";
    const isUnspecified = !rawDeadline || rawDeadline.toLowerCase() === "not specified";

    return {
      id: row.id,
      task: row.content,
      rationale: row.rationale,
      ownerId: matchedSpeaker?.id,
      ownerLabel: isUnassigned ? null : rawOwner,
      deadline: isUnspecified ? undefined : rawDeadline,
      done: row.isCompleted,
      userEdited: row.isUserEdited,
      evidence: parseEvidenceRefs(row.evidenceRefsJson, notes, transcript, screenshots),
    };
  });

  const customMap = new Map<string, CustomSynthesisSection>();
  for (const row of customRows) {
    const section = customMap.get(row.itemType) ?? {
      itemType: row.itemType,
      label: humanizeSectionType(row.itemType),
      items: [],
    };
    section.items.push({
      id: row.id,
      text: row.content,
      rationale: row.rationale,
      userEdited: row.isUserEdited,
      evidence: parseEvidenceRefs(row.evidenceRefsJson, notes, transcript, screenshots),
    });
    customMap.set(row.itemType, section);
  }
  const customSections = [...customMap.values()];

  const totalClaims = sorted.length;
  const groundedClaims = sorted.filter((row) => {
    const refs = parseEvidenceRefs(row.evidenceRefsJson, notes, transcript, screenshots);
    return refs.length > 0;
  }).length;
  const confidence = totalClaims > 0 ? groundedClaims / totalClaims : 0;

  const headline =
    paragraphs[0]?.text.split(/(?<=[.!?])\s+/)[0] ||
    (totalClaims > 0 ? `${meetingTitle} — Grounded Synthesis` : "No synthesis generated yet");

  const keyPoints = [
    ...decisions.slice(0, 2).map((d) => d.text),
    ...actions.slice(0, 2).map((a) => a.task),
  ].slice(0, 4);

  return {
    summary: {
      headline,
      paragraphs,
      keyPoints,
      confidence,
      groundedClaims,
      totalClaims,
    },
    decisions,
    actions,
    customSections,
  };
}

export function adaptMeetingToStudio(bundle: VaultMeetingBundle): Meeting {
  const { meeting, notes, transcript, screenshots, synthesis, speakers, folders, tags } = bundle;
  const speakerById = new Map<string, SpeakerRecord>(speakers.map((s) => [s.id, s]));
  const speakerByName = new Map<string, SpeakerRecord>(
    speakers.map((s) => [s.displayName.toLowerCase(), s]),
  );

  const participantMap = new Map<string, Speaker>();
  let toneIndex = 0;

  const ensureParticipant = (
    rawLabel: string,
    speakerIdFromRow?: string | null,
    channel?: string,
  ): Speaker => {
    const dbSpeaker =
      (speakerIdFromRow ? speakerById.get(speakerIdFromRow) : undefined) ??
      speakerByName.get(rawLabel.trim().toLowerCase());
    const displayName = dbSpeaker?.displayName || rawLabel.trim() || "Speaker";
    const key = dbSpeaker?.id || `spk-${speakerSlug(displayName)}`;
    const existing = participantMap.get(key);
    if (existing) return existing;

    const isYou =
      Boolean(dbSpeaker?.isLocalUser) || displayName.toLowerCase() === "you" || channel === "mic";
    const tone: SpeakerTone = isYou ? "violet" : SPEAKER_TONES[toneIndex++ % SPEAKER_TONES.length];

    const created: Speaker = {
      id: key,
      name: displayName,
      role: isYou ? "Local mic" : channel === "system" ? "Remote audio" : "Participant",
      tone,
      isYou,
    };
    participantMap.set(key, created);
    return created;
  };

  const orderedTranscript = [...transcript].sort((a, b) => a.seqNo - b.seqNo);
  const orderedScreenshots = [...screenshots].sort((a, b) => a.startMs - b.startMs);

  // Pair each screenshot to the closest overlapping or nearby transcript segment
  // so inline slide cards appear naturally in the transcript stream.
  const screenshotSegmentLink = new Map<string, string>();
  for (const shot of orderedScreenshots) {
    let bestSegment: TranscriptSegmentRecord | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const seg of orderedTranscript) {
      if (shot.startMs >= seg.startMs - 2_000 && shot.startMs <= seg.endMs + 5_000) {
        bestSegment = seg;
        bestDelta = 0;
        break;
      }
      const delta = Math.abs(seg.startMs - shot.startMs);
      if (delta < bestDelta && delta <= 15_000) {
        bestDelta = delta;
        bestSegment = seg;
      }
    }
    if (bestSegment && !screenshotSegmentLink.has(bestSegment.id)) {
      screenshotSegmentLink.set(bestSegment.id, shot.id);
    }
  }

  const isRecordingActive = meeting.status === "recording";
  const adaptedTranscripts: TranscriptSegment[] = orderedTranscript.map((seg, idx) => {
    const participant = ensureParticipant(seg.speakerLabel, seg.speakerId, seg.audioChannel);
    const isActivelyStreaming =
      isRecordingActive && !seg.isConfirmed && idx === orderedTranscript.length - 1;
    return {
      id: seg.id,
      seqNo: seg.seqNo,
      startMs: seg.startMs,
      endMs: Math.max(seg.startMs + 250, seg.endMs),
      speakerId: participant.id,
      speakerLabelRaw: seg.speakerLabel,
      audioChannel: seg.audioChannel,
      confirmedText: seg.text,
      unconfirmedText: undefined,
      screenshotId: screenshotSegmentLink.get(seg.id),
      live: isActivelyStreaming,
    };
  });

  if (participantMap.size === 0) {
    participantMap.set("you", {
      id: "you",
      name: "You",
      role: "Local mic",
      tone: "violet",
      isYou: true,
    });
  }

  const orderedNotes = [...notes].sort((a, b) => a.lineIndex - b.lineIndex);
  const adaptedNotes: NoteLine[] = orderedNotes.map((note) => ({
    id: note.id,
    lineIndex: note.lineIndex,
    startMs: note.recordingOffsetMs ?? 0,
    kind: mapBlockKind(note.blockType, note.contentMd),
    text: cleanBlockText(note.contentMd),
    linkedScreenshotId: note.linkedScreenshotId,
  }));

  const adaptedScreenshots: Screenshot[] = orderedScreenshots.map((shot, idx) =>
    adaptScreenshotRecord(shot, idx),
  );

  const participants = [...participantMap.values()];
  const { summary, decisions, actions, customSections } = adaptSynthesisRecords(
    meeting.title,
    synthesis,
    orderedNotes,
    orderedTranscript,
    orderedScreenshots,
    participants,
  );

  const folderName =
    (meeting.folderId
      ? folders.find((folder) => folder.id === meeting.folderId)?.name
      : undefined) ?? "Vault";

  const maxSegmentEndMs = orderedTranscript.reduce((max, seg) => Math.max(max, seg.endMs), 0);
  const maxShotEndMs = orderedScreenshots.reduce((max, shot) => Math.max(max, shot.endMs), 0);
  const computedDurationMs = Math.max(meeting.durationMs, maxSegmentEndMs, maxShotEndMs);

  return {
    id: meeting.id,
    title: meeting.title,
    status: meeting.status,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
    dateLabel: formatDateLabel(meeting.createdAt),
    startedAtISO: new Date(meeting.createdAt).toISOString(),
    durationMs: computedDurationMs,
    folder: folderName,
    folderId: meeting.folderId,
    isStarred: meeting.isStarred,
    tags,
    audioFilePath: meeting.audioFilePath,
    systemAudioFilePath: meeting.systemAudioFilePath,
    systemAudioStartedAtMs: meeting.systemAudioStartedAtMs,
    diarizationEnabled: meeting.diarizationEnabled,
    screenshotIntervalSec: meeting.screenshotIntervalSec,
    asrModelId: meeting.asrModelId,
    slmModelId: meeting.slmModelId,
    manualNotesRawMd: meeting.manualNotesRawMd,
    isDemo: false,
    participants,
    notes: adaptedNotes,
    transcripts: adaptedTranscripts,
    screenshots: adaptedScreenshots,
    decisions,
    actions,
    customSections,
    summary,
  };
}
