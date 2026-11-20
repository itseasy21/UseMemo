/**
 * Complete typed command facade over the Tauri IPC contract.
 *
 * Read queries use `invokeCommand` where background effects benefit from
 * fail-soft `null` in browser previews, while all user-initiated mutations and
 * primary loads use `invokeHost` / `invokeRequired` so real Tauri errors
 * surface to the user with actionable messages.
 */

import type { BrandManifest } from "@/generated/brand";
import {
  invokeCommand,
  invokeHost,
  invokeRequired,
  type MeetingRecord,
  type ScreenshotCapturedPayload,
  type ScreenshotRecord,
} from "@/lib/tauri";

export type { MeetingRecord, ScreenshotCapturedPayload, ScreenshotRecord };

export type BrandConfigRecord = {
  brandId: string;
  productName: string;
  tagline: string;
  companyName: string;
  bundleIdentifier: string;
  deepLinkScheme: string;
  storageDirName: string;
  sqliteFileName: string;
  licenseType: string;
  dataDir: string;
  modelsDir: string;
  exportsDir: string;
  overrideApplied: boolean;
  manifestJson: string;
};

export type RecordingSnapshot = {
  meetingId: string;
  startedAtMs: number;
  intervalSec: number;
  paused: boolean;
  micDevice: string | null;
  micSampleRate: number | null;
};

export type CaptureTargetInput =
  { kind: "auto" } | { kind: "display"; id: number } | { kind: "window"; id: number };

export type VisualCaptureTargetRecord = {
  kind: "display" | "window" | string;
  id: number;
  title: string;
  appName: string;
  width: number;
  height: number;
};

export type CaptureTargetsResponseRecord = {
  microphones: string[];
  visualTargets: VisualCaptureTargetRecord[];
  activeTarget: CaptureTargetInput;
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

export type NewNoteBlockInput = {
  lineIndex: number;
  blockType?: string;
  contentMd: string;
  recordingOffsetMs?: number | null;
  linkedScreenshotId?: string | null;
};

export type SaveNotesInput = {
  meetingId: string;
  rawMd: string;
  blocks: NewNoteBlockInput[];
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

export type SynthesisItemPatchInput = {
  content?: string;
  rationale?: string;
  owner?: string;
  deadline?: string;
  isCompleted?: boolean;
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

export type FolderRecord = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
};

export type SearchFiltersInput = {
  folderId?: string | null;
  meetingId?: string | null;
  limit?: number;
};

export type SearchHitRecord = {
  meetingId: string;
  title: string;
  snippet: string;
  rank: number;
};

export type ModelRoleId =
  "asr" | "fallback_asr" | "diarization_segmentation" | "speaker_embedding" | "slm" | "pro_slm";

export type ModelFileRecord = {
  filename: string;
  sizeBytes: number;
  sha256: string;
};

export type ModelArtifactRecord = {
  id: string;
  role: ModelRoleId;
  repo: string;
  files: ModelFileRecord[];
  description: string;
  minRamGb: number;
  recommended: boolean;
  accelerator: string;
};

export type ModelStatusRecord = {
  artifact: ModelArtifactRecord;
  installed: boolean;
  installedBytes: number;
};

export type HardwareTier = "low" | "mid" | "high";

export type HardwareProfileRecord = {
  tier: HardwareTier;
  ramBytes: number;
  ramGb: number;
  arch: string;
  os: string;
  accelerator: string;
  metal: boolean;
  vulkan: boolean;
  xnnpackCpu: boolean;
  npu: string;
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
  channels: number;
  /** Distinct speaker labels in the stored transcript, including `You`/`Them`. */
  speakerCount: number;
  durationMs: number;
};

/** Mirrors the host's `audio_capabilities` command. */
export type AudioCapabilitiesRecord = {
  microphone: boolean;
  systemAudio: boolean;
  systemBackend: "screencapturekit" | "wasapi" | string | null;
  systemAudioPermissionRequired: boolean;
  systemAudioPermissionGranted: boolean;
  screenshotCapture: boolean;
  diarization: boolean;
  echoCancellation: boolean;
  archiveSampleRate: number;
  note: string | null;
};

export type VaultCountsRecord = {
  meetings: number;
  transcriptSegments: number;
  noteBlocks: number;
  screenshots: number;
  synthesisItems: number;
  speakers: number;
  folders: number;
};

export type ModelDiagnosticRecord = {
  id: string;
  repo: string;
  installed: boolean;
  totalBytes: number;
};

export type DiagnosticsBundleRecord = {
  generatedAt: string;
  brandId: string;
  productName: string;
  bundleIdentifier: string;
  overrideApplied: boolean;
  synthesisEngineId: string;
  hardware: HardwareProfileRecord;
  audioCapabilities: AudioCapabilitiesRecord;
  models: ModelDiagnosticRecord[];
  vaultCounts: VaultCountsRecord;
  recoveredSessionsOnBoot: number;
  logsDir: string;
  recentLogs: string[];
};

export type ExportDiagnosticsOutcomeRecord = {
  path: string;
  bytes: number;
  logLines: number;
};

export type CreateMeetingPayload = {
  title?: string;
  screenshotIntervalSec?: number;
  asrModelId?: string;
  slmModelId?: string;
  folderId?: string;
  /** Split loopback speech into `Speaker N` labels after the take. Defaults on. */
  diarization?: boolean;
};

export type UpdateMeetingPatchInput = {
  title?: string;
  folderId?: string;
  clearFolder?: boolean;
  diarizationEnabled?: boolean;
  asrModelId?: string;
  slmModelId?: string;
};

export type AppendTranscriptInput = {
  meetingId: string;
  seqNo: number;
  startMs: number;
  endMs: number;
  speakerLabel: string;
  audioChannel?: "mic" | "system";
  text: string;
  isConfirmed?: boolean;
  isFinal?: boolean;
};

// --- Brand & Diagnostics ---

export function getBrandConfig() {
  return invokeCommand<BrandConfigRecord>("get_brand_config");
}

export function getBrandManifest() {
  return invokeCommand<BrandManifest>("get_brand_manifest");
}

export function getDiagnosticsSummary() {
  return invokeHost<DiagnosticsBundleRecord>("get_diagnostics_summary");
}

export function exportDiagnostics(destinationDir?: string) {
  return invokeHost<ExportDiagnosticsOutcomeRecord>("export_diagnostics", {
    destinationDir: destinationDir ?? null,
  });
}

// --- Meetings & Recording ---

export function createMeeting(input: CreateMeetingPayload) {
  return invokeHost<MeetingRecord>("create_meeting", { input });
}

export function updateMeeting(meetingId: string, patch: UpdateMeetingPatchInput) {
  return invokeHost<MeetingRecord>("update_meeting", { meetingId, patch });
}

export function listMeetings() {
  return invokeCommand<MeetingRecord[]>("list_meetings");
}

export function getMeeting(meetingId: string) {
  return invokeHost<MeetingRecord>("get_meeting", { meetingId });
}

export function finishMeeting(meetingId: string, durationMs: number) {
  return invokeHost<MeetingRecord>("finish_meeting", { meetingId, durationMs });
}

export function deleteMeeting(meetingId: string) {
  return invokeHost<void>("delete_meeting", { meetingId });
}

export function discardFailedMeeting(meetingId: string) {
  return invokeHost<void>("discard_failed_meeting", { meetingId });
}

export function setMeetingStarred(meetingId: string, starred: boolean) {
  return invokeHost<MeetingRecord>("set_meeting_starred", { meetingId, starred });
}

export function setMeetingTags(meetingId: string, tags: string[]) {
  return invokeHost<string[]>("set_meeting_tags", { meetingId, tags });
}

export function getMeetingTags(meetingId: string) {
  return invokeCommand<string[]>("get_meeting_tags", { meetingId });
}

export function listAllTags() {
  return invokeCommand<string[]>("list_all_tags");
}

export function setScreenshotInterval(meetingId: string, intervalSec: number) {
  return invokeHost<void>("set_screenshot_interval", { meetingId, intervalSec });
}

export function listCaptureTargets() {
  return invokeCommand<CaptureTargetsResponseRecord>("list_capture_targets");
}

export function setCaptureTarget(target: CaptureTargetInput) {
  return invokeHost<CaptureTargetInput>("set_capture_target", { target });
}

export type StartRecordingOptions = {
  /** Request the platform loopback as a second archive. */
  captureSystemAudio?: boolean;
  /** Optional microphone device name (`cpal` input device). */
  microphoneDevice?: string | null;
  /** Optional display or window target for screenshot capture. */
  captureTarget?: CaptureTargetInput | null;
};

export type StartRecordingOutcomeRecord = {
  meeting: MeetingRecord;
  systemAudioWarning: string | null;
};

export function startRecording(meetingId: string, options: StartRecordingOptions = {}) {
  return invokeHost<StartRecordingOutcomeRecord>("start_recording", {
    meetingId,
    captureSystemAudio: options.captureSystemAudio ?? false,
    microphoneDevice: options.microphoneDevice ?? null,
    captureTarget: options.captureTarget ?? null,
  });
}

export function requestSystemAudioAccess() {
  return invokeCommand<boolean>("request_system_audio_access");
}

export function pauseRecording(meetingId: string) {
  return invokeHost<RecordingSnapshot>("pause_recording", { meetingId });
}

export function resumeRecording(meetingId: string) {
  return invokeHost<RecordingSnapshot>("resume_recording", { meetingId });
}

export function stopRecording(meetingId: string) {
  return invokeHost<MeetingRecord>("stop_recording", { meetingId });
}

export function recordingStatus() {
  return invokeCommand<RecordingSnapshot | null>("recording_status");
}

export type MicrophonePermission = "granted" | "denied" | "prompt" | "unsupported";

export type AudioSessionStatus = {
  configured: boolean;
  backend: string;
};

export function microphonePermission() {
  return invokeCommand<MicrophonePermission>("microphone_permission");
}

/** Ask for microphone consent before opening the capture backend. */
export function requestMicrophonePermission() {
  return invokeCommand<MicrophonePermission>("request_microphone_permission");
}

/** Activate the platform session (iOS category, Android audio focus). */
export function configureAudioSession() {
  return invokeCommand<AudioSessionStatus>("configure_audio_session");
}

/** Release the platform session after a take, whether it started or not. */
export function deactivateAudioSession() {
  return invokeCommand<{ deactivated: boolean }>("deactivate_audio_session");
}

export function getAudioCapabilities() {
  return invokeCommand<AudioCapabilitiesRecord>("audio_capabilities");
}

// --- Notes ---

export function saveNotes(input: SaveNotesInput) {
  return invokeHost<NoteBlockRecord[]>("save_notes", { input });
}

export function listNotes(meetingId: string) {
  return invokeCommand<NoteBlockRecord[]>("list_notes", { meetingId });
}

// --- Transcript & Speakers ---

/** Transcribe the meeting's saved audio with the installed on-device model. */
export function transcribeMeeting(meetingId: string) {
  return invokeRequired<TranscriptionOutcomeRecord>("transcribe_meeting", { meetingId });
}

export function cancelTranscription() {
  return invokeHost<void>("cancel_transcription");
}

export function appendTranscript(input: AppendTranscriptInput) {
  return invokeHost<TranscriptSegmentRecord>("append_transcript", { input });
}

export function listTranscript(meetingId: string) {
  return invokeCommand<TranscriptSegmentRecord[]>("list_transcript", { meetingId });
}

export function updateTranscriptSegment(
  segmentId: string,
  patch: { text?: string | null; speakerLabel?: string | null },
) {
  return invokeHost<TranscriptSegmentRecord>("update_transcript_segment", {
    segmentId,
    text: patch.text ?? null,
    speakerLabel: patch.speakerLabel ?? null,
  });
}

export function listSpeakers() {
  return invokeCommand<SpeakerRecord[]>("list_speakers");
}

export function upsertSpeaker(displayName: string, isLocalUser = false) {
  return invokeHost<SpeakerRecord>("upsert_speaker", { displayName, isLocalUser });
}

export function renameSpeaker(
  meetingId: string,
  oldLabel: string,
  newName: string,
  saveVoiceprint = false,
) {
  return invokeHost<SpeakerRecord>("rename_speaker", {
    meetingId,
    oldLabel,
    newName,
    saveVoiceprint,
  });
}

// --- Screenshots ---

export function listScreenshots(meetingId: string) {
  return invokeCommand<ScreenshotRecord[]>("list_screenshots", { meetingId });
}

export function deleteScreenshot(screenshotId: string) {
  return invokeHost<void>("delete_screenshot", { screenshotId });
}

export function captureScreenshot(meetingId: string) {
  return invokeHost<ScreenshotCapturedPayload>("capture_screenshot", { meetingId });
}

export function updateScreenshotOcr(screenshotId: string, text: string) {
  return invokeHost<void>("update_screenshot_ocr", { screenshotId, text });
}

export function analyzeScreenshotOcr(screenshotId: string) {
  return invokeHost<ScreenshotRecord>("analyze_screenshot_ocr", { screenshotId });
}

// --- Synthesis & Export ---

export type AssistantCitationRecord = {
  label: string;
  meetingId?: string | null;
  seekMs?: number | null;
};

export type AssistantResponseRecord = {
  answer: string;
  engineId: string;
  citations: AssistantCitationRecord[];
};

export function synthesizeMeeting(meetingId: string, template?: string) {
  return invokeHost<SynthesisResponse>("synthesize_meeting", {
    meetingId,
    template: template ?? null,
  });
}

export function listSynthesis(meetingId: string) {
  return invokeCommand<SynthesisItemRecord[]>("list_synthesis", { meetingId });
}

export function createSynthesisItem(input: {
  meetingId: string;
  itemType?: string;
  content: string;
  owner?: string | null;
  deadline?: string | null;
}) {
  return invokeHost<SynthesisItemRecord>("create_synthesis_item", {
    meetingId: input.meetingId,
    itemType: input.itemType ?? "action_item",
    content: input.content,
    owner: input.owner ?? null,
    deadline: input.deadline ?? null,
  });
}

export function updateSynthesisItem(itemId: string, patch: SynthesisItemPatchInput) {
  return invokeHost<SynthesisItemRecord>("update_synthesis_item", { itemId, patch });
}

export function synthesisContextPreview(meetingId: string) {
  return invokeHost<string>("synthesis_context_preview", { meetingId });
}

export function askAssistant(question: string, meetingId?: string | null) {
  return invokeHost<AssistantResponseRecord>("ask_assistant", {
    question,
    meetingId: meetingId ?? null,
  });
}

export function exportMeeting(meetingId: string, targetDir?: string) {
  return invokeHost<ExportOutcomeRecord>("export_meeting", {
    meetingId,
    targetDir: targetDir ?? null,
  });
}

// --- Search & Folders ---

export function searchVaultHost(query: string, filters?: SearchFiltersInput) {
  return invokeCommand<SearchHitRecord[]>("search", {
    query,
    filters: filters ?? null,
  });
}

export function rebuildSearchIndex() {
  return invokeHost<void>("rebuild_search_index");
}

export function createFolder(name: string, parentId?: string | null) {
  return invokeHost<FolderRecord>("create_folder", { name, parentId: parentId ?? null });
}

export function renameFolder(folderId: string, name: string) {
  return invokeHost<FolderRecord>("rename_folder", { folderId, name });
}

export function deleteFolder(folderId: string) {
  return invokeHost<void>("delete_folder", { folderId });
}

export function listFolders() {
  return invokeCommand<FolderRecord[]>("list_folders");
}

// --- Models & Hardware ---

export function listModels() {
  return invokeCommand<ModelHubResponse>("list_models");
}

export function probeHardware() {
  return invokeCommand<HardwareProfileRecord>("probe_hardware");
}

export function downloadModel(artifactId: string) {
  return invokeHost<DownloadReportRecord[]>("download_model", { artifactId });
}

export function cancelModelDownload(artifactId: string) {
  return invokeHost<boolean>("cancel_model_download", { artifactId });
}

export function deleteModel(artifactId: string) {
  return invokeHost<number>("delete_model", { artifactId });
}
