/**
 * Thin, typed command façade over the Tauri IPC contract.
 *
 * Every helper returns `null` in a plain browser or when the host rejects the
 * call, so call sites can keep their local demo data as a fallback without
 * branching on transport details.
 */

import {
  invokeCommand,
  invokeRequired,
  type MeetingRecord,
  type ScreenshotRecord,
} from "@/lib/tauri";

export type { MeetingRecord, ScreenshotRecord };

export type RecordingSnapshot = {
  meetingId: string;
  startedAtMs: number;
  intervalSec: number;
};

export type TranscriptSegmentRecord = {
  id: string;
  meetingId: string;
  seqNo: number;
  startMs: number;
  endMs: number;
  speakerId: string | null;
  speakerLabel: string;
  audioChannel: string;
  text: string;
  isConfirmed: boolean;
};

export type NoteBlockRecord = {
  id: string;
  meetingId: string;
  lineIndex: number;
  blockType: string;
  contentMd: string;
  recordingOffsetMs: number | null;
  linkedScreenshotId: string | null;
};

export type SpeakerRecord = {
  id: string;
  displayName: string;
  colorHex: string;
  isLocalUser: boolean;
  createdAt: number;
};

export type SynthesisItemRecord = {
  id: string;
  meetingId: string;
  itemType: string;
  sortOrder: number;
  content: string;
  rationale: string | null;
  owner: string | null;
  deadline: string | null;
  isCompleted: boolean;
  isUserEdited: boolean;
  evidenceRefsJson: string;
};

export type VerificationReportRecord = {
  rawItems: number;
  keptItems: number;
  droppedWithoutValidEvidence: number;
  strippedEvidenceRefs: number;
  forcedUnassignedOwners: number;
  forcedUnspecifiedDeadlines: number;
};

export type SynthesisResponse = {
  items: SynthesisItemRecord[];
  report: VerificationReportRecord;
  engineId: string;
};

export type ModelFileRecord = {
  filename: string;
  sizeBytes: number;
  sha256: string;
};

export type ModelArtifactRecord = {
  id: string;
  role: string;
  repo: string;
  files: ModelFileRecord[];
  description: string;
};

export type ModelStatusRecord = {
  artifact: ModelArtifactRecord;
  installed: boolean;
  installedBytes: number;
};

export type HardwareProfileRecord = {
  tier: string;
  ramBytes: number;
  arch: string;
  os: string;
  metal: boolean;
  npu: string;
  accelerator: string;
};

export type ModelHubResponse = {
  hardware: HardwareProfileRecord;
  models: ModelStatusRecord[];
};

export type DownloadReportRecord = {
  path: string;
  bytes: number;
  sha256: string;
  resumedFrom: number;
};

export type ExportOutcomeRecord = {
  folder: string;
  markdownPath: string;
  markdownBytes: number;
  copiedImages: number;
  missingImages: string[];
};

export type TranscriptionOutcomeRecord = {
  engineId: string;
  modelId: string;
  segments: number;
  blocks: number;
  skippedBlocks: number;
  durationMs: number;
};

export type CreateMeetingPayload = {
  title?: string;
  screenshotIntervalSec?: number;
  asrModelId?: string;
  slmModelId?: string;
  folderId?: string;
};

export function createMeeting(input: CreateMeetingPayload) {
  return invokeCommand<MeetingRecord>("create_meeting", { input });
}

export function listMeetings() {
  return invokeCommand<MeetingRecord[]>("list_meetings");
}

export function getMeeting(meetingId: string) {
  return invokeCommand<MeetingRecord>("get_meeting", { meetingId });
}

export function startRecording(meetingId: string) {
  return invokeCommand<MeetingRecord>("start_recording", { meetingId });
}

export function stopRecording(meetingId: string) {
  return invokeCommand<MeetingRecord>("stop_recording", { meetingId });
}

export function recordingStatus() {
  return invokeCommand<RecordingSnapshot | null>("recording_status");
}

export function synthesizeMeeting(meetingId: string) {
  return invokeCommand<SynthesisResponse>("synthesize_meeting", { meetingId });
}

export function exportMeeting(meetingId: string) {
  return invokeCommand<ExportOutcomeRecord>("export_meeting", { meetingId });
}

export function captureScreenshot(meetingId: string) {
  return invokeCommand<unknown>("capture_screenshot", { meetingId });
}

export function listScreenshots(meetingId: string) {
  return invokeCommand<ScreenshotRecord[]>("list_screenshots", { meetingId });
}

/** Transcribe the meeting's saved audio with the installed on-device model. */
export function transcribeMeeting(meetingId: string) {
  return invokeRequired<TranscriptionOutcomeRecord>("transcribe_meeting", { meetingId });
}

export function listTranscript(meetingId: string) {
  return invokeCommand<TranscriptSegmentRecord[]>("list_transcript", { meetingId });
}

export function listNotes(meetingId: string) {
  return invokeCommand<NoteBlockRecord[]>("list_notes", { meetingId });
}

export function listSpeakers() {
  return invokeCommand<SpeakerRecord[]>("list_speakers");
}

export function listSynthesis(meetingId: string) {
  return invokeCommand<SynthesisItemRecord[]>("list_synthesis", { meetingId });
}

export function listModels() {
  return invokeCommand<ModelHubResponse>("list_models");
}

export function downloadModel(artifactId: string) {
  return invokeCommand<DownloadReportRecord[]>("download_model", { artifactId });
}

export function deleteModel(artifactId: string) {
  return invokeCommand<number>("delete_model", { artifactId });
}
