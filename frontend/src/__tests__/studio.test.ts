import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { meetingHref, synthesisHref } from "@/lib/demo-data";
import { isImeComposing } from "@/lib/ime";
import {
  escapeHtml,
  markdownToHtml,
  noteLinesToHtml,
  parseTimestampToMs,
  serializeRawMarkdownToNotePayload,
} from "@/lib/markdown";
import {
  adaptMeetingToStudio,
  adaptScreenshotRecord,
  adaptSynthesisRecords,
  parseEvidenceRefs,
} from "@/lib/meeting-adapter";
import { HostError, formatHostError } from "@/lib/tauri";

const FRONTEND_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("markdown parser handles headings, inline code, blockquotes, and fenced code blocks", () => {
  const md = [
    "## Architecture Notes",
    "",
    "> Decision: keep SQLite FTS5 local",
    "",
    "```rust",
    "let ok = 1 < 2 && true;",
    "```",
  ].join("\n");

  const html = markdownToHtml(md);
  assert.match(html, /<h2>Architecture Notes<\/h2>/);
  assert.match(html, /<blockquote><p>Decision: keep SQLite FTS5 local<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>let ok = 1 &lt; 2 &amp;&amp; true;<\/code><\/pre>/);
});

test("markdown timestamp parser and note payload serializer preserve offsets", () => {
  assert.equal(parseTimestampToMs("01:30"), 90_000);
  assert.equal(parseTimestampToMs("01:02:03"), 3_723_000);
  assert.equal(parseTimestampToMs("invalid"), null);

  const payload = serializeRawMarkdownToNotePayload(
    "## Sprint Goal\n\nTODO verify offline export",
    [12_000, 45_000],
  );
  assert.equal(payload.blocks.length, 2);
  assert.equal(payload.blocks[0].blockType, "heading");
  assert.equal(payload.blocks[0].recordingOffsetMs, 12_000);
  assert.equal(payload.blocks[1].blockType, "todo");
  assert.equal(payload.blocks[1].recordingOffsetMs, 45_000);

  const rendered = noteLinesToHtml([
    { id: "n1", startMs: 5_000, kind: "decision", text: "Ship <script> safely" },
  ]);
  assert.ok(!rendered.includes("<script>"));
  assert.equal(escapeHtml('<mark>"ok"</mark>'), "&lt;mark&gt;&quot;ok&quot;&lt;/mark&gt;");
});

test("IME Enter guard catches both standard isComposing and WebKit keyCode 229", () => {
  assert.equal(isImeComposing({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isImeComposing({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } }), true);
  assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false);
});

test("dynamic meeting routes encode demo slugs and arbitrary SQLite UUIDs for static export", () => {
  assert.equal(meetingHref("demo-q3-launch"), "/meeting/?id=demo-q3-launch");
  assert.equal(synthesisHref("demo-q3-launch"), "/meeting/synthesis/?id=demo-q3-launch");
  assert.equal(
    meetingHref("0190f3a1-1111-7222-8333-444455556666"),
    "/meeting/?id=0190f3a1-1111-7222-8333-444455556666",
  );
  assert.equal(
    synthesisHref("0190f3a1-1111-7222-8333-444455556666"),
    "/meeting/synthesis/?id=0190f3a1-1111-7222-8333-444455556666",
  );
});

test("meeting adapter resolves T-MM:SS#N, N-L#, S-MM:SS citations and custom SOAP sections", () => {
  const notes = [
    {
      id: "note-1",
      meetingId: "m-1",
      lineIndex: 1,
      blockType: "paragraph",
      contentMd: "Patient reports mild headache since Tuesday.",
      recordingOffsetMs: 15_000,
      linkedScreenshotId: null,
    },
  ];
  const transcript = [
    {
      id: "seg-1",
      meetingId: "m-1",
      seqNo: 1,
      startMs: 40_000,
      endMs: 40_400,
      speakerId: "spk-1",
      speakerLabel: "Dr. Patel",
      audioChannel: "mic",
      text: "First utterance at forty seconds.",
      isConfirmed: true,
    },
    {
      id: "seg-2",
      meetingId: "m-1",
      seqNo: 2,
      startMs: 40_500,
      endMs: 44_000,
      speakerId: "spk-2",
      speakerLabel: "Alex",
      audioChannel: "system",
      text: "Follow up scheduled for Wednesday.",
      isConfirmed: true,
    },
  ];
  const screenshots = [
    {
      id: "shot-1",
      meetingId: "m-1",
      startMs: 65_000,
      endMs: 75_000,
      filePath: "/vault/media/m-1/shots/shot-1.webp",
      width: 1280,
      height: 720,
      dhash: "0123456789abcdef",
      captureTrigger: "manual",
      ocrExtractedText: "BP 122/78 mmHg",
    },
  ];

  const refs = parseEvidenceRefs(
    JSON.stringify(["T-00:40#2", "N-L1", "S-01:05"]),
    notes,
    transcript,
    screenshots,
  );
  assert.equal(refs.length, 3);
  assert.equal(refs[0].id, "seg-2");
  assert.equal(refs[1].id, "note-1");
  assert.equal(refs[2].id, "shot-1");

  const adaptedShot = adaptScreenshotRecord(screenshots[0], 0);
  assert.equal(adaptedShot.title, "BP 122/78 mmHg");
  assert.equal(adaptedShot.trigger, "manual");

  const adaptedSynth = adaptSynthesisRecords(
    "Consultation",
    [
      {
        id: "syn-1",
        meetingId: "m-1",
        itemType: "action_item",
        sortOrder: 0,
        content: "Order follow-up lab panel",
        rationale: null,
        owner: "Dr. Patel",
        deadline: "Wednesday",
        isCompleted: true,
        isUserEdited: true,
        evidenceRefsJson: JSON.stringify(["T-00:40#2"]),
      },
      {
        id: "syn-2",
        meetingId: "m-1",
        itemType: "subjective",
        sortOrder: 0,
        content: "Mild headache reported since Tuesday.",
        rationale: null,
        owner: null,
        deadline: null,
        isCompleted: false,
        isUserEdited: false,
        evidenceRefsJson: JSON.stringify(["N-L1"]),
      },
    ],
    notes,
    transcript,
    screenshots,
    [{ id: "spk-1", name: "Dr. Patel", role: "Clinician", tone: "accent" }],
  );

  assert.equal(adaptedSynth.actions.length, 1);
  assert.equal(adaptedSynth.actions[0].done, true);
  assert.equal(adaptedSynth.actions[0].userEdited, true);
  assert.equal(adaptedSynth.actions[0].ownerId, "spk-1");
  assert.equal(adaptedSynth.customSections.length, 1);
  assert.equal(adaptedSynth.customSections[0].itemType, "subjective");

  const fullMeeting = adaptMeetingToStudio({
    meeting: {
      id: "m-1",
      title: "Consultation",
      status: "completed",
      createdAt: 1_763_097_600_000,
      updatedAt: 1_763_097_660_000,
      durationMs: 90_000,
      audioFilePath: "/vault/media/m-1/audio.wav",
      systemAudioFilePath: "/vault/media/m-1/audio-system.wav",
      systemAudioStartedAtMs: 500,
      diarizationEnabled: true,
      screenshotIntervalSec: 10,
      asrModelId: "whisper-small",
      slmModelId: "gemma-3-4b-it",
      manualNotesRawMd: "Patient reports mild headache since Tuesday.",
      folderId: null,
      isStarred: true,
    },
    notes,
    transcript,
    screenshots,
    synthesis: [],
    speakers: [],
    folders: [],
    tags: ["clinical", "followup"],
  });

  assert.equal(fullMeeting.isStarred, true);
  assert.deepEqual(fullMeeting.tags, ["clinical", "followup"]);
  assert.equal(fullMeeting.participants.length, 2);
});

test("HostError preserves structured command failure messages", () => {
  const err = new HostError("synthesize_meeting", "no on-device synthesis model is installed");
  assert.equal(err.command, "synthesize_meeting");
  assert.match(formatHostError(err), /no on-device synthesis model is installed/);
});

test("static Next.js export artifact directory contains all routes and bundled offline fonts", () => {
  const outDir = path.join(FRONTEND_ROOT, "out");
  if (!fs.existsSync(outDir)) {
    // Allow running unit tests before `pnpm build` if `out/` has not been generated yet.
    return;
  }
  const requiredPaths = [
    "index.html",
    "hud/index.html",
    "models/index.html",
    "meeting/index.html",
    "meeting/synthesis/index.html",
    "fonts/sans-latin.woff2",
    "fonts/mono-latin.woff2",
    "brand/wordmark-dark.svg",
  ];
  for (const rel of requiredPaths) {
    assert.ok(fs.existsSync(path.join(outDir, rel)), `missing static export file: out/${rel}`);
  }

  const homeHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  assert.ok(!homeHtml.includes("fonts.googleapis.com"), "must not load remote web fonts");
});
