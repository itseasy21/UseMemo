import { BRAND, MODEL_REGISTRY } from "@/generated/brand";

/**
 * The local demo vault. Shaped exactly like the repository records the Tauri
 * commands will return, so swapping demo data for host data is a transport
 * change only.
 */

export type SpeakerTone = "accent" | "secondary" | "warm" | "violet";
export type NoteKind = "heading" | "note" | "decision" | "todo" | "bookmark";
export type SlidePalette = "emerald" | "indigo" | "amber" | "violet" | "slate";

export type Speaker = {
  id: string;
  name: string;
  role: string;
  tone: SpeakerTone;
  isYou?: boolean;
};

export type NoteLine = {
  id: string;
  startMs: number;
  kind: NoteKind;
  text: string;
};

export type TranscriptSegment = {
  id: string;
  startMs: number;
  endMs: number;
  speakerId: string;
  confirmedText: string;
  unconfirmedText?: string;
  screenshotId?: string;
  live?: boolean;
};

export type Screenshot = {
  id: string;
  startMs: number;
  title: string;
  caption: string;
  slideText: string;
  palette: SlidePalette;
  trigger: "interval" | "manual" | "slide-change";
};

export type EvidenceRef =
  | { kind: "transcript"; id: string }
  | { kind: "note"; id: string }
  | { kind: "screenshot"; id: string };

export type Decision = {
  id: string;
  text: string;
  evidence: EvidenceRef[];
  userEdited?: boolean;
};

export type ActionItem = {
  id: string;
  task: string;
  ownerId?: string;
  deadline?: string;
  evidence: EvidenceRef[];
  done?: boolean;
  userEdited?: boolean;
};

export type SynthesisSummary = {
  headline: string;
  paragraphs: Array<{ id: string; text: string; evidence: EvidenceRef[] }>;
  keyPoints: string[];
  confidence: number;
  groundedClaims: number;
  totalClaims: number;
};

export type Meeting = {
  id: string;
  title: string;
  dateLabel: string;
  startedAtISO: string;
  durationMs: number;
  folder: string;
  tags: string[];
  participants: Speaker[];
  notes: NoteLine[];
  transcripts: TranscriptSegment[];
  screenshots: Screenshot[];
  decisions: Decision[];
  actions: ActionItem[];
  summary: SynthesisSummary;
};

export type DemoModelFile = {
  filename: string;
  sizeBytes: number;
  sha256: string;
};

export type DemoModelStatus = "installed" | "downloading" | "available";

export type DemoModel = {
  id: string;
  name: string;
  role: string;
  repo: string;
  description: string;
  files: DemoModelFile[];
  accelerator: string;
  minRamGb: number;
  recommended: boolean;
  enabled: boolean;
  status: DemoModelStatus;
  verified: boolean;
  downloadProgress: number;
  speedMbps: number;
};

const q3Participants: Speaker[] = [
  { id: "sarah", name: "Sarah Chen", role: "Head of Product", tone: "accent" },
  { id: "alex", name: "Alex Rivera", role: "Engineering Lead", tone: "secondary" },
  { id: "you", name: "You", role: "Product", tone: "violet", isYou: true },
];

const billingParticipants: Speaker[] = [
  { id: "sarah", name: "Sarah Chen", role: "Staff Engineer", tone: "accent" },
  { id: "alex", name: "Alex Rivera", role: "Billing Lead", tone: "secondary" },
  { id: "you", name: "You", role: "Product", tone: "violet", isYou: true },
];

const designParticipants: Speaker[] = [
  { id: "sarah", name: "Sarah Chen", role: "Design Lead", tone: "accent" },
  { id: "alex", name: "Alex Rivera", role: "Engineering", tone: "secondary" },
  { id: "you", name: "You", role: "Product", tone: "violet", isYou: true },
];

const q3Launch: Meeting = {
  id: "demo-q3-launch",
  title: "Q3 launch readiness",
  dateLabel: "Today · 10:00 AM",
  startedAtISO: "2026-11-14T10:00:00-08:00",
  durationMs: 2_742_000,
  folder: "Launch",
  tags: ["Q3", "launch", "billing", "go-to-market"],
  participants: q3Participants,
  notes: [
    { id: "q3-n1", startMs: 22_000, kind: "heading", text: "Launch frame" },
    {
      id: "q3-n2",
      startMs: 45_000,
      kind: "note",
      text: "Six-week runway. Beta gates at week three; GA is a migration milestone, not a calendar date.",
    },
    {
      id: "q3-n3",
      startMs: 84_000,
      kind: "note",
      text: "Billing migration is the only hard dependency. Everything else can slip a day.",
    },
    {
      id: "q3-n4",
      startMs: 260_000,
      kind: "note",
      text: "Slide: three-phase rollout — 250-account beta → GA → partner enablement.",
    },
    {
      id: "q3-n5",
      startMs: 724_000,
      kind: "decision",
      text: "Run a staged rollout. Beta cohort capped at 250 accounts; public GA waits for billing cutover and two clean dry runs.",
    },
    {
      id: "q3-n6",
      startMs: 1_100_000,
      kind: "note",
      text: "Pricing experiment is a Q4 surface. Do not expand launch scope.",
    },
    {
      id: "q3-n7",
      startMs: 1_180_000,
      kind: "todo",
      text: "Alex: draft billing migration runbook + rollback checklist by Oct 3.",
    },
    {
      id: "q3-n8",
      startMs: 1_872_000,
      kind: "note",
      text: "App Store review timing is unowned. Release ops has not assigned a DRI.",
    },
    {
      id: "q3-n9",
      startMs: 2_465_000,
      kind: "todo",
      text: "Instrument pricing flags behind the Q4 gate. No exposure in Q3.",
    },
  ],
  transcripts: [
    {
      id: "q3-t1",
      startMs: 12_000,
      endMs: 42_000,
      speakerId: "sarah",
      confirmedText:
        "Let's start with launch scope. I want the room aligned on the one thing that can actually move GA.",
    },
    {
      id: "q3-t2",
      startMs: 45_000,
      endMs: 83_000,
      speakerId: "you",
      confirmedText:
        "Runway is six weeks. Beta gate at week three. We can hold the date if billing doesn't surprise us.",
    },
    {
      id: "q3-t3",
      startMs: 84_000,
      endMs: 128_000,
      speakerId: "sarah",
      confirmedText: "And if it does?",
    },
    {
      id: "q3-t4",
      startMs: 129_000,
      endMs: 166_000,
      speakerId: "alex",
      confirmedText:
        "Then it isn't a launch problem, it's a migration problem. The cutover needs a rollback path before we invite customers.",
    },
    {
      id: "q3-t5",
      startMs: 168_000,
      endMs: 220_000,
      speakerId: "you",
      confirmedText:
        "We have two dry runs budgeted. The second one has to include a restore, not just a forward migration.",
    },
    {
      id: "q3-t6",
      startMs: 260_000,
      endMs: 298_000,
      speakerId: "sarah",
      confirmedText:
        "This is the sequence we're proposing: 250-account beta, then GA, then partner enablement. The slide is in the vault.",
      screenshotId: "q3-s1",
    },
    {
      id: "q3-t7",
      startMs: 310_000,
      endMs: 360_000,
      speakerId: "alex",
      confirmedText:
        "One constraint: billing migration must land first. If we dual-write without a replay harness, finance won't sign off.",
    },
    {
      id: "q3-t8",
      startMs: 724_000,
      endMs: 780_000,
      speakerId: "sarah",
      confirmedText:
        "Okay. Decision: staged rollout, beta capped at 250. Public GA waits for billing cutover and two clean dry runs.",
    },
    {
      id: "q3-t9",
      startMs: 781_000,
      endMs: 820_000,
      speakerId: "you",
      confirmedText:
        "Capped at 250 means we can hand-hold support. I'll write that into the beta plan.",
    },
    {
      id: "q3-t10",
      startMs: 1_100_000,
      endMs: 1_145_000,
      speakerId: "alex",
      confirmedText:
        "Pricing experiment? If we keep it in Q3 we're adding a second migration for no learning.",
    },
    {
      id: "q3-t11",
      startMs: 1_145_000,
      endMs: 1_180_000,
      speakerId: "sarah",
      confirmedText: "Agreed, park it. Q4. Instrumentation can ship dark.",
    },
    {
      id: "q3-t12",
      startMs: 1_180_000,
      endMs: 1_230_000,
      speakerId: "sarah",
      confirmedText:
        "Alex, can you draft the migration runbook and rollback checklist? Aim for October 3.",
    },
    {
      id: "q3-t13",
      startMs: 1_872_000,
      endMs: 1_925_000,
      speakerId: "you",
      confirmedText: "App Store review timing. I don't see an owner in the plan.",
    },
    {
      id: "q3-t14",
      startMs: 1_925_000,
      endMs: 1_960_000,
      speakerId: "sarah",
      confirmedText:
        "It's unowned. Release ops hasn't assigned a DRI. Flag it as unassigned until we have a name.",
    },
    {
      id: "q3-t15",
      startMs: 2_465_000,
      endMs: 2_520_000,
      speakerId: "sarah",
      confirmedText:
        "One last thing: pricing experiment moves to Q4. Flags ship dark, instrumentation only.",
      screenshotId: "q3-s3",
    },
    {
      id: "q3-t16",
      startMs: 2_600_000,
      endMs: 2_640_000,
      speakerId: "sarah",
      confirmedText: "We'll walk the beta list on Monday.",
      unconfirmedText: "And then confirm the support rota with—",
      live: true,
    },
  ],
  screenshots: [
    {
      id: "q3-s1",
      startMs: 260_000,
      title: "Three-phase rollout",
      caption: "Launch sequencing",
      slideText:
        "Phase 1 — 250-account beta · Phase 2 — public GA after rollback proof · Phase 3 — partner enablement.",
      palette: "emerald",
      trigger: "slide-change",
    },
    {
      id: "q3-s2",
      startMs: 720_000,
      title: "Launch timeline",
      caption: "Beta gate + GA dependency",
      slideText:
        "Weeks 0–3: migration dry runs · Week 3: beta · GA: after two clean dry runs · Week 8: partner enablement.",
      palette: "indigo",
      trigger: "interval",
    },
    {
      id: "q3-s3",
      startMs: 2_460_000,
      title: "Pricing experiment matrix",
      caption: "Deferred to Q4",
      slideText:
        "Q3: instrumentation only · Q4: exposure tests · Guardrail: no billing surface changes.",
      palette: "amber",
      trigger: "interval",
    },
  ],
  decisions: [
    {
      id: "q3-d1",
      text: "Run a staged rollout: 250-account beta, then public GA, then partner enablement.",
      evidence: [
        { kind: "transcript", id: "q3-t8" },
        { kind: "note", id: "q3-n5" },
        { kind: "screenshot", id: "q3-s2" },
      ],
    },
    {
      id: "q3-d2",
      text: "Billing migration blocks public launch; two clean dry runs including a restore are required.",
      evidence: [
        { kind: "transcript", id: "q3-t7" },
        { kind: "note", id: "q3-n3" },
      ],
    },
    {
      id: "q3-d3",
      text: "Move the pricing experiment to Q4. Instrumentation ships dark in Q3.",
      evidence: [
        { kind: "transcript", id: "q3-t11" },
        { kind: "note", id: "q3-n6" },
        { kind: "screenshot", id: "q3-s3" },
      ],
      userEdited: true,
    },
  ],
  actions: [
    {
      id: "q3-a1",
      task: "Draft billing migration runbook and rollback checklist",
      ownerId: "alex",
      deadline: "Oct 3",
      evidence: [
        { kind: "transcript", id: "q3-t12" },
        { kind: "note", id: "q3-n7" },
      ],
    },
    {
      id: "q3-a2",
      task: "Confirm App Store review timing with release ops",
      evidence: [
        { kind: "transcript", id: "q3-t13" },
        { kind: "note", id: "q3-n8" },
      ],
    },
    {
      id: "q3-a3",
      task: "Publish beta cohort criteria and support rota",
      ownerId: "sarah",
      deadline: "Sep 29",
      done: true,
      evidence: [
        { kind: "transcript", id: "q3-t8" },
        { kind: "note", id: "q3-n5" },
      ],
    },
    {
      id: "q3-a4",
      task: "Instrument pricing flags behind the Q4 gate (no exposure)",
      ownerId: "you",
      deadline: "Oct 10",
      userEdited: true,
      evidence: [
        { kind: "transcript", id: "q3-t15" },
        { kind: "note", id: "q3-n9" },
        { kind: "screenshot", id: "q3-s3" },
      ],
    },
  ],
  summary: {
    headline: "Staged rollout with billing as the gate",
    paragraphs: [
      {
        id: "q3-sum-p1",
        text: "The team is holding a six-week runway to the Q3 launch. Billing migration is the critical path; public GA waits on a rollback-proven cutover and two clean dry runs.",
        evidence: [
          { kind: "transcript", id: "q3-t2" },
          { kind: "note", id: "q3-n2" },
          { kind: "transcript", id: "q3-t7" },
        ],
      },
      {
        id: "q3-sum-p2",
        text: "A 250-account beta starts in week three and is capped by support capacity. Pricing work is parked for Q4, and App Store review timing remains without an accountable owner.",
        evidence: [
          { kind: "transcript", id: "q3-t8" },
          { kind: "note", id: "q3-n5" },
          { kind: "screenshot", id: "q3-s2" },
        ],
      },
    ],
    keyPoints: [
      "250-account beta at week three",
      "Billing cutover is the hard gate",
      "App Store review DRI unresolved",
      "Pricing experiment moved to Q4",
    ],
    confidence: 0.94,
    groundedClaims: 12,
    totalClaims: 12,
  },
};

const billingArch: Meeting = {
  id: "demo-billing-arch",
  title: "Billing architecture review",
  dateLabel: "Yesterday · 2:30 PM",
  startedAtISO: "2026-11-13T14:30:00-08:00",
  durationMs: 1_938_000,
  folder: "Architecture",
  tags: ["billing", "ADR-014", "reliability", "replay"],
  participants: billingParticipants,
  notes: [
    { id: "bill-n1", startMs: 34_000, kind: "heading", text: "Current flow" },
    {
      id: "bill-n2",
      startMs: 38_000,
      kind: "note",
      text: "Stripe webhook → ledger → entitlements. 72-hour retry window today; finance wants seven-day replay.",
    },
    {
      id: "bill-n3",
      startMs: 122_000,
      kind: "note",
      text: "Double-write duplicates invoices unless the inbox is idempotent. Event ID dedupe is non-negotiable.",
    },
    {
      id: "bill-n4",
      startMs: 192_000,
      kind: "decision",
      text: "Persist raw events in an inbox first, dedupe by Stripe event ID, then replay downstream. Inbox precedes dual-write.",
    },
    {
      id: "bill-n5",
      startMs: 527_000,
      kind: "decision",
      text: "Ledger stays append-only. Restatements are compensating entries, never mutations.",
    },
    {
      id: "bill-n6",
      startMs: 724_000,
      kind: "note",
      text: "Enterprise needs a source-invoice hash to prove restatements. Backfill before replay starts.",
    },
    {
      id: "bill-n7",
      startMs: 1_120_000,
      kind: "todo",
      text: "Alex: invoice hash backfill by Nov 21. Covers all enterprise accounts.",
    },
    {
      id: "bill-n8",
      startMs: 1_450_000,
      kind: "note",
      text: "Replay harness is unowned. Dual-write is blocked until it exists.",
    },
    {
      id: "bill-n9",
      startMs: 1_812_000,
      kind: "todo",
      text: "Publish ADR-014 with inbox → hash → replay sequence by Nov 18.",
    },
  ],
  transcripts: [
    {
      id: "bill-t1",
      startMs: 34_000,
      endMs: 77_000,
      speakerId: "sarah",
      confirmedText:
        "Let's ground this in the current flow. Every Stripe event lands in the webhook handler, then the ledger, then entitlement materialization.",
    },
    {
      id: "bill-t2",
      startMs: 78_000,
      endMs: 121_000,
      speakerId: "you",
      confirmedText:
        "The retry window is 72 hours today, but finance is asking for seven-day replay before the audit.",
    },
    {
      id: "bill-t3",
      startMs: 122_000,
      endMs: 190_000,
      speakerId: "alex",
      confirmedText:
        "Double-write is the part that worries me. Without an idempotency key on the inbox, we will duplicate invoices on the first replay.",
    },
    {
      id: "bill-t4",
      startMs: 192_000,
      endMs: 260_000,
      speakerId: "sarah",
      confirmedText:
        "Then the decision is inbox first. Persist raw events, dedupe by Stripe event ID, and replay downstream.",
    },
    {
      id: "bill-t5",
      startMs: 527_000,
      endMs: 610_000,
      speakerId: "sarah",
      confirmedText:
        "And the ledger stays append-only. If we need to restate, we write compensating entries. No soft deletes, no mutation.",
      screenshotId: "bill-s1",
    },
    {
      id: "bill-t6",
      startMs: 724_000,
      endMs: 800_000,
      speakerId: "you",
      confirmedText:
        "For enterprise accounts we need a hash of the source invoice. Otherwise a restatement isn't provable.",
      screenshotId: "bill-s2",
    },
    {
      id: "bill-t7",
      startMs: 1_120_000,
      endMs: 1_190_000,
      speakerId: "alex",
      confirmedText:
        "I can backfill those hashes next week, before the replay harness. Let's call it November 21.",
    },
    {
      id: "bill-t8",
      startMs: 1_450_000,
      endMs: 1_520_000,
      speakerId: "sarah",
      confirmedText:
        "The replay harness is unowned. We should not start dual-write without it. Mark it unassigned.",
    },
    {
      id: "bill-t9",
      startMs: 1_812_000,
      endMs: 1_880_000,
      speakerId: "you",
      confirmedText:
        "ADR-014 will cover the full sequence: inbox, hash backfill, replay, then dual-write. I'll publish it November 18.",
      screenshotId: "bill-s3",
    },
    {
      id: "bill-t10",
      startMs: 1_890_000,
      endMs: 1_938_000,
      speakerId: "alex",
      confirmedText: "That sequence is defensible to finance.",
      unconfirmedText: "The only open question is who owns the replay—",
      live: true,
    },
  ],
  screenshots: [
    {
      id: "bill-s1",
      startMs: 520_000,
      title: "Ledger invariants",
      caption: "Append-only ledger",
      slideText:
        "No mutation · Restatements are compensating entries · Every entry carries an idempotency key.",
      palette: "indigo",
      trigger: "slide-change",
    },
    {
      id: "bill-s2",
      startMs: 720_000,
      title: "Restatement proof",
      caption: "Enterprise invoice hashes",
      slideText:
        "Hash source invoice → store with ledger entry → compare on replay · 1,142 accounts in scope.",
      palette: "emerald",
      trigger: "interval",
    },
    {
      id: "bill-s3",
      startMs: 1_800_000,
      title: "Delivery sequence",
      caption: "ADR-014 rollout",
      slideText:
        "1. Webhook inbox in staging · 2. Invoice hash backfill · 3. Seven-day replay harness · 4. Dual-write.",
      palette: "violet",
      trigger: "slide-change",
    },
  ],
  decisions: [
    {
      id: "bill-d1",
      text: "Adopt an idempotent webhook inbox before dual-write; dedupe on Stripe event ID.",
      evidence: [
        { kind: "transcript", id: "bill-t4" },
        { kind: "note", id: "bill-n4" },
        { kind: "screenshot", id: "bill-s1" },
      ],
    },
    {
      id: "bill-d2",
      text: "The ledger remains append-only; corrections are compensating entries.",
      evidence: [
        { kind: "transcript", id: "bill-t5" },
        { kind: "note", id: "bill-n5" },
        { kind: "screenshot", id: "bill-s1" },
      ],
      userEdited: true,
    },
    {
      id: "bill-d3",
      text: "The seven-day replay harness gates dual-write rollout.",
      evidence: [
        { kind: "transcript", id: "bill-t8" },
        { kind: "note", id: "bill-n8" },
      ],
    },
  ],
  actions: [
    {
      id: "bill-a1",
      task: "Backfill invoice hashes for enterprise accounts",
      ownerId: "alex",
      deadline: "Nov 21",
      evidence: [
        { kind: "transcript", id: "bill-t7" },
        { kind: "note", id: "bill-n7" },
        { kind: "screenshot", id: "bill-s2" },
      ],
    },
    {
      id: "bill-a2",
      task: "Write seven-day replay harness",
      evidence: [
        { kind: "transcript", id: "bill-t8" },
        { kind: "note", id: "bill-n8" },
      ],
    },
    {
      id: "bill-a3",
      task: "Publish ADR-014 and sequence diagram",
      ownerId: "you",
      deadline: "Nov 18",
      done: true,
      evidence: [
        { kind: "transcript", id: "bill-t9" },
        { kind: "note", id: "bill-n9" },
        { kind: "screenshot", id: "bill-s3" },
      ],
    },
    {
      id: "bill-a4",
      task: "Enable webhook inbox in staging",
      ownerId: "sarah",
      deadline: "Nov 25",
      evidence: [
        { kind: "transcript", id: "bill-t4" },
        { kind: "note", id: "bill-n4" },
      ],
    },
  ],
  summary: {
    headline: "Inbox first, then dual-write",
    paragraphs: [
      {
        id: "bill-sum-p1",
        text: "Billing will adopt an idempotent webhook inbox before any dual-write. Raw Stripe events are persisted and deduplicated on event ID, then replayed downstream. The ledger remains append-only.",
        evidence: [
          { kind: "transcript", id: "bill-t4" },
          { kind: "note", id: "bill-n4" },
          { kind: "screenshot", id: "bill-s1" },
        ],
      },
      {
        id: "bill-sum-p2",
        text: "Enterprise invoice hashes must be backfilled before replay. The seven-day replay harness is still unowned, which blocks dual-write. ADR-014 documents the delivery sequence.",
        evidence: [
          { kind: "transcript", id: "bill-t7" },
          { kind: "transcript", id: "bill-t8" },
          { kind: "note", id: "bill-n8" },
        ],
      },
    ],
    keyPoints: [
      "Idempotent inbox before dual-write",
      "Append-only ledger, compensating restatements",
      "1,142 enterprise invoice hashes in scope",
      "Replay harness has no owner",
    ],
    confidence: 0.97,
    groundedClaims: 14,
    totalClaims: 14,
  },
};

const designCrit: Meeting = {
  id: "demo-design-crit",
  title: "Onboarding critique · pass 2",
  dateLabel: "Mon · Nov 9",
  startedAtISO: "2026-11-09T15:00:00-08:00",
  durationMs: 1_690_000,
  folder: "Design",
  tags: ["onboarding", "consent", "first-run"],
  participants: designParticipants,
  notes: [
    { id: "dc-n1", startMs: 20_000, kind: "heading", text: "What we saw" },
    {
      id: "dc-n2",
      startMs: 45_000,
      kind: "note",
      text: "First-run asks for workspace, role, and recording consent before the user has seen a memo.",
    },
    {
      id: "dc-n3",
      startMs: 260_000,
      kind: "note",
      text: "Drop-off is 31% on the consent step. The copy reads legal, not local-first.",
    },
    {
      id: "dc-n4",
      startMs: 620_000,
      kind: "decision",
      text: "Move consent after the first recording and show the local vault path inline.",
    },
    {
      id: "dc-n5",
      startMs: 1_020_000,
      kind: "todo",
      text: "Alex: prototype a three-step first-run with system audio opt-in by Nov 20.",
    },
    {
      id: "dc-n6",
      startMs: 1_340_000,
      kind: "todo",
      text: "You: rewrite consent copy. Lead with 'stays on this device'.",
    },
    {
      id: "dc-n7",
      startMs: 1_500_000,
      kind: "bookmark",
      text: "Sarah's paper prototype: 5 participants, 4 finished without a prompt.",
    },
  ],
  transcripts: [
    {
      id: "dc-t1",
      startMs: 20_000,
      endMs: 70_000,
      speakerId: "sarah",
      confirmedText:
        "The first-run is asking for everything before it has earned anything. Workspace, role, consent.",
    },
    {
      id: "dc-t2",
      startMs: 72_000,
      endMs: 130_000,
      speakerId: "you",
      confirmedText:
        "And the consent step is where we lose 31%. The copy sounds like legal reviewed it, not like we keep recordings local.",
    },
    {
      id: "dc-t3",
      startMs: 260_000,
      endMs: 320_000,
      speakerId: "alex",
      confirmedText:
        "We could show the vault path in the consent sheet. That makes the promise concrete instead of a paragraph.",
    },
    {
      id: "dc-t4",
      startMs: 620_000,
      endMs: 690_000,
      speakerId: "sarah",
      confirmedText:
        "Decision: consent moves after the first recording, and the vault path is visible inline. No bundled consent.",
      screenshotId: "dc-s1",
    },
    {
      id: "dc-t5",
      startMs: 1_020_000,
      endMs: 1_100_000,
      speakerId: "alex",
      confirmedText:
        "I'll prototype the three-step flow with system audio as an explicit opt-in. November 20.",
    },
    {
      id: "dc-t6",
      startMs: 1_340_000,
      endMs: 1_420_000,
      speakerId: "you",
      confirmedText:
        "I'll rewrite the consent copy. The first line should be 'your notes stay on this device'.",
    },
    {
      id: "dc-t7",
      startMs: 1_500_000,
      endMs: 1_560_000,
      speakerId: "sarah",
      confirmedText:
        "The paper prototype had four of five finishing without a prompt. That's the bar for the real flow.",
      screenshotId: "dc-s2",
    },
  ],
  screenshots: [
    {
      id: "dc-s1",
      startMs: 600_000,
      title: "First-run flow v3",
      caption: "Three-step prototype",
      slideText:
        "Step 1: name the vault · Step 2: record a sample · Step 3: consent + local path. Role moves to settings.",
      palette: "violet",
      trigger: "slide-change",
    },
    {
      id: "dc-s2",
      startMs: 1_500_000,
      title: "Consent copy variants",
      caption: "Local-first language test",
      slideText:
        "A: 'Allow processing' · B: 'Stays on this device' · Winner: B, 4/5 completed without help.",
      palette: "slate",
      trigger: "slide-change",
    },
  ],
  decisions: [
    {
      id: "dc-d1",
      text: "Consent moves after the first recording; the local vault path is shown inline.",
      evidence: [
        { kind: "transcript", id: "dc-t4" },
        { kind: "note", id: "dc-n4" },
        { kind: "screenshot", id: "dc-s1" },
      ],
    },
    {
      id: "dc-d2",
      text: "System audio remains an explicit opt-in; no bundled recording consent.",
      evidence: [
        { kind: "transcript", id: "dc-t5" },
        { kind: "note", id: "dc-n5" },
      ],
      userEdited: true,
    },
  ],
  actions: [
    {
      id: "dc-a1",
      task: "Prototype three-step first-run with system audio opt-in",
      ownerId: "alex",
      deadline: "Nov 20",
      evidence: [
        { kind: "transcript", id: "dc-t5" },
        { kind: "note", id: "dc-n5" },
        { kind: "screenshot", id: "dc-s1" },
      ],
    },
    {
      id: "dc-a2",
      task: "Rewrite consent copy around local-first retention",
      ownerId: "you",
      deadline: "Nov 19",
      userEdited: true,
      evidence: [
        { kind: "transcript", id: "dc-t6" },
        { kind: "note", id: "dc-n6" },
      ],
    },
    {
      id: "dc-a3",
      task: "Schedule five-user paper prototype",
      ownerId: "sarah",
      deadline: "Nov 17",
      done: true,
      evidence: [
        { kind: "transcript", id: "dc-t7" },
        { kind: "note", id: "dc-n7" },
        { kind: "screenshot", id: "dc-s2" },
      ],
    },
  ],
  summary: {
    headline: "Earn consent with a visible local vault",
    paragraphs: [
      {
        id: "dc-sum-p1",
        text: "First-run friction concentrates on the consent step. The team will move consent after the first recording and surface the local vault path so the privacy promise is concrete.",
        evidence: [
          { kind: "transcript", id: "dc-t2" },
          { kind: "transcript", id: "dc-t4" },
          { kind: "note", id: "dc-n4" },
        ],
      },
      {
        id: "dc-sum-p2",
        text: "System audio stays an explicit opt-in. A three-step prototype and a consent-copy rewrite are due before the next critique.",
        evidence: [
          { kind: "transcript", id: "dc-t5" },
          { kind: "note", id: "dc-n5" },
          { kind: "screenshot", id: "dc-s1" },
        ],
      },
    ],
    keyPoints: [
      "31% drop-off on consent",
      "Vault path shown inline",
      "System audio stays opt-in",
      "4/5 finished the paper prototype",
    ],
    confidence: 0.89,
    groundedClaims: 9,
    totalClaims: 10,
  },
};

export const MEETINGS: Meeting[] = [q3Launch, billingArch, designCrit];
export const MEETING_IDS = MEETINGS.map((meeting) => meeting.id);
export const FEATURED_MEETING = q3Launch;

export function getMeeting(id: string): Meeting {
  return MEETINGS.find((meeting) => meeting.id === id) ?? FEATURED_MEETING;
}

export function getSpeaker(meeting: Meeting, speakerId: string): Speaker {
  return (
    meeting.participants.find((speaker) => speaker.id === speakerId) ?? {
      id: speakerId,
      name: "Speaker",
      role: "Unknown",
      tone: "violet",
    }
  );
}

export function getNote(meeting: Meeting, noteId: string): NoteLine | undefined {
  return meeting.notes.find((note) => note.id === noteId);
}

export function getTranscript(meeting: Meeting, segmentId: string): TranscriptSegment | undefined {
  return meeting.transcripts.find((segment) => segment.id === segmentId);
}

export function getScreenshot(meeting: Meeting, screenshotId: string): Screenshot | undefined {
  return meeting.screenshots.find((screenshot) => screenshot.id === screenshotId);
}

export function noteIndex(meeting: Meeting, noteId: string): number {
  return meeting.notes.findIndex((note) => note.id === noteId);
}

export function evidenceLabel(meeting: Meeting, ref: EvidenceRef): string {
  if (ref.kind === "transcript") {
    const segment = getTranscript(meeting, ref.id);
    return `T ${segment ? formatEvidenceTime(segment.startMs) : "00:00"}`;
  }
  if (ref.kind === "note") {
    const index = noteIndex(meeting, ref.id);
    return `N #${index >= 0 ? index + 1 : "?"}`;
  }
  const screenshot = getScreenshot(meeting, ref.id);
  return `S ${screenshot ? formatEvidenceTime(screenshot.startMs) : "00:00"}`;
}

function formatEvidenceTime(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function evidenceTime(meeting: Meeting, ref: EvidenceRef): number {
  if (ref.kind === "transcript") return getTranscript(meeting, ref.id)?.startMs ?? 0;
  if (ref.kind === "note") return getNote(meeting, ref.id)?.startMs ?? 0;
  return getScreenshot(meeting, ref.id)?.startMs ?? 0;
}

export function evidenceExcerpt(meeting: Meeting, ref: EvidenceRef): string {
  if (ref.kind === "transcript") {
    const segment = getTranscript(meeting, ref.id);
    return segment ? getSpeaker(meeting, segment.speakerId).name : "Transcript";
  }
  if (ref.kind === "note") {
    const note = getNote(meeting, ref.id);
    return note ? truncate(note.text, 64) : "Note";
  }
  const screenshot = getScreenshot(meeting, ref.id);
  return screenshot ? screenshot.title : "Screenshot";
}

export function evidenceDomId(meetingId: string, ref: EvidenceRef): string {
  return `evidence-${meetingId}-${ref.kind}-${ref.id}`;
}

export function speakerForSegment(meeting: Meeting, segment: TranscriptSegment): Speaker {
  return getSpeaker(meeting, segment.speakerId);
}

export function truncate(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export function meetingActionOwner(meeting: Meeting, action: ActionItem): Speaker | null {
  if (!action.ownerId) return null;
  return meeting.participants.find((speaker) => speaker.id === action.ownerId) ?? null;
}

export const PENDING_ACTIONS = MEETINGS.flatMap((meeting) =>
  meeting.actions
    .filter((action) => !action.done)
    .map((action) => ({ meeting, action, owner: meetingActionOwner(meeting, action) })),
);

export const VAULT_STATS = {
  memoCount: 42,
  capturedHours: 18.6,
  screenshots: 128,
  storageBytes: 1_842_000_000,
  indexedRows: 1_284,
  pendingActions: PENDING_ACTIONS.length,
  speakers: 7,
  folders: 4,
  tags: 9,
} as const;

export const DEMO_HARDWARE = {
  host: "Apple M1 Pro",
  cpu: "8-core CPU · 6P + 2E",
  gpu: "16-core GPU",
  npu: "16-core Apple Neural Engine",
  ramGb: 16,
  os: "macOS 27.2 · arm64",
  tier: "High",
  accelerators: ["Metal 3", "XNNPACK", "Core ML", "ANE"],
  usage: {
    cpu: 0.18,
    ram: 0.46,
    gpu: 0.12,
    npu: 0.07,
  },
} as const;

export const DEMO_MODELS: DemoModel[] = [
  {
    id: "whisper-small",
    name: "Whisper Small",
    role: "Speech → text",
    repo: MODEL_REGISTRY.defaultAsrRepo,
    description:
      "Quantized Whisper small, 99 languages, CPU inference through whisper.cpp. Fully on-device.",
    files: [
      {
        filename: "ggml-small-q5_1.bin",
        sizeBytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
      },
    ],
    accelerator: "CPU · NEON / AVX2",
    minRamGb: 8,
    recommended: true,
    enabled: true,
    status: "installed",
    verified: true,
    downloadProgress: 100,
    speedMbps: 0,
  },
  {
    id: "whisper-tiny",
    name: "Whisper Tiny",
    role: "Fallback speech → text",
    repo: MODEL_REGISTRY.fallbackAsrRepo,
    description:
      "Quantized Whisper tiny, 99 languages, ultra-low RAM fallback for constrained hosts.",
    files: [
      {
        filename: "ggml-tiny-q5_1.bin",
        sizeBytes: 32_152_673,
        sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
      },
    ],
    accelerator: "XNNPACK CPU",
    minRamGb: 4,
    recommended: false,
    enabled: false,
    status: "available",
    verified: false,
    downloadProgress: 0,
    speedMbps: 0,
  },
  {
    id: "gemma-4-e2b-it",
    name: "Gemma 4 E2B IT",
    role: "Synthesis SLM",
    repo: MODEL_REGISTRY.defaultSlmRepo,
    description:
      "QAT INT4, 32k context, text + vision synthesis for 8–15 GB systems. Supports slide OCR grounding.",
    files: [
      {
        filename: "gemma-4-E2B-it.litertlm",
        sizeBytes: 2_588_147_712,
        sha256: "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
      },
    ],
    accelerator: "Metal / Vulkan / XNNPACK",
    minRamGb: 8,
    recommended: false,
    enabled: false,
    status: "downloading",
    verified: false,
    downloadProgress: 68,
    speedMbps: 42.6,
  },
  {
    id: "gemma-4-e4b-it",
    name: "Gemma 4 E4B IT",
    role: "Pro synthesis SLM",
    repo: MODEL_REGISTRY.proSlmRepo,
    description:
      "Higher-reasoning QAT INT4 SLM for 16 GB+ hosts. Selected automatically on this machine's high hardware tier.",
    files: [
      {
        filename: "gemma-4-E4B-it.litertlm",
        sizeBytes: 3_659_530_240,
        sha256: "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
      },
    ],
    accelerator: "Metal / Vulkan / XNNPACK",
    minRamGb: 16,
    recommended: true,
    enabled: true,
    status: "installed",
    verified: true,
    downloadProgress: 100,
    speedMbps: 0,
  },
];

export const DEMO_INSTALLED_BYTES = DEMO_MODELS.filter(
  (model) => model.status === "installed",
).reduce((total, model) => total + model.files.reduce((sum, file) => sum + file.sizeBytes, 0), 0);

export const DEMO_MODEL_FOOTPRINT = `${(DEMO_INSTALLED_BYTES / 1024 ** 3).toFixed(1)} GB`;

export const DEMO_VAULT_PATH = `~/Library/Application Support/${BRAND.storageDirName}/${BRAND.sqliteFileName}`;

export const DEMO_INDEX = {
  engine: "SQLite FTS5",
  journal: "WAL",
  pages: 3_481,
  indexedRows: VAULT_STATS.indexedRows,
  lastVacuum: "2026-11-10",
} as const;
