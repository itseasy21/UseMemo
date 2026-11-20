"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  Cpu,
  Download,
  FileJson,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";

import { AppShell } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { BRAND } from "@/generated/brand";
import { useModelDownloadProgress } from "@/hooks/use-host-event";
import { DEMO_HARDWARE, DEMO_MODELS, type DemoModelStatus } from "@/lib/demo-data";
import { formatBytes } from "@/lib/format";
import {
  cancelModelDownload,
  deleteModel,
  downloadModel,
  exportDiagnostics,
  getBrandConfig,
  listModels,
  type HardwareProfileRecord,
  type ModelFileRecord,
} from "@/lib/host";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

type CatalogItem = {
  id: string;
  name: string;
  roleLabel: string;
  isSynthesis: boolean;
  repo: string;
  description: string;
  files: ModelFileRecord[];
  accelerator: string;
  minRamGb: number;
  recommended: boolean;
  status: DemoModelStatus;
  progress: number;
  installedBytes: number;
};

const FRIENDLY_NAMES: Record<
  string,
  { title: string; subtitle: string; summary: string; badge?: string }
> = {
  "whisper-large-v3-turbo": {
    title: "Whisper Large v3 Turbo",
    subtitle: "Studio-grade voice recognition · 8× faster",
    summary:
      "Flagship 99-language speech model quantized for Apple Silicon Metal GPU (547 MB) with near-zero word error rate.",
    badge: "Best Accuracy",
  },
  "whisper-small": {
    title: "Whisper Small",
    subtitle: "Balanced voice recognition",
    summary: "Best balance of speed and accuracy across 99 languages with speaker turn alignment.",
  },
  "whisper-tiny": {
    title: "Whisper Tiny",
    subtitle: "Ultra-fast voice recognition",
    summary: "Lightweight 31 MB model for instant transcription and 4 GB memory devices.",
  },
  "qwen3.5-4b": {
    title: "Qwen 3.5 4B",
    subtitle: "Next-Gen 8 GB+ Flagship · Gated DeltaNet",
    summary:
      "Outperforms Qwen 2.5 7B on structured JSON summaries, action items, and grounded Q&A while running fast in 8 GB RAM.",
    badge: "Best for 8–16 GB",
  },
  "gemma-4-e2b-it": {
    title: "Gemma 4 E2B",
    subtitle: "Google Effective-2B · Low-RAM Reasoning",
    summary:
      "Per-Layer Embedding architecture delivering 4B-class meeting synthesis with a 2B active memory footprint on 8 GB+ Macs.",
    badge: "New · Gemma 4",
  },
  "gemma-4-e4b-it": {
    title: "Gemma 4 E4B",
    subtitle: "Google Effective-4B · 128k Pro Context",
    summary:
      "Flagship on-device Gemma 4 model for deep multi-speaker reasoning, executive briefs, and clinical SOAP notes on 16 GB+ Macs.",
    badge: "Best for 16 GB+",
  },
  "lfm2.5-1.2b-instruct": {
    title: "LiquidAI LFM 2.5 1.2B",
    subtitle: "Ultra-Fast State-Space Hybrid · 697 MB",
    summary:
      "Liquid Foundation Model with 3× lower memory bandwidth than standard Transformers — instant summaries on any 8 GB Mac.",
    badge: "Ultra-Light",
  },
  "lfm2.5-2.6b-instruct": {
    title: "LiquidAI LFM 2.5 2.6B",
    subtitle: "High-Throughput Liquid Model · 1.56 GB",
    summary:
      "Stronger 2.6B Liquid Foundation Model combining rapid token generation with a compact 1.56 GB footprint for 8–16 GB Macs.",
    badge: "Low Memory",
  },
  "qwen2.5-3b-instruct": {
    title: "Qwen 2.5 3B",
    subtitle: "Classic 3B meeting summaries",
    summary: "Generates grounded executive summaries, decisions, and tasks with source citations.",
  },
  "gemma-3-4b-it": {
    title: "Gemma 3 4B",
    subtitle: "Classic 4B pro notes",
    summary: "Higher-capacity model for detailed synthesis and complex multi-speaker meetings.",
  },
};

const DISPLAY_ORDER: Record<string, number> = {
  "whisper-large-v3-turbo": 1,
  "whisper-small": 2,
  "whisper-tiny": 3,
  "qwen3.5-4b": 10,
  "gemma-4-e2b-it": 11,
  "lfm2.5-1.2b-instruct": 12,
  "lfm2.5-2.6b-instruct": 13,
  "gemma-4-e4b-it": 14,
  "qwen2.5-3b-instruct": 15,
  "gemma-3-4b-it": 16,
};

function formatModelDisplayName(id: string): string {
  if (FRIENDLY_NAMES[id]) return FRIENDLY_NAMES[id].title;
  return id
    .split("-")
    .map((part) => {
      if (/^e\d+b$/i.test(part) || /^it$/i.test(part) || /^q\d/i.test(part)) {
        return part.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function roleLabelFor(role: string): { label: string; isSynthesis: boolean } {
  switch (role) {
    case "asr":
      return { label: "Voice to Text", isSynthesis: false };
    case "fallback_asr":
      return { label: "Compact Voice to Text", isSynthesis: false };
    case "slm":
      return { label: "Meeting Summary", isSynthesis: true };
    case "pro_slm":
      return { label: "Pro Meeting Summary", isSynthesis: true };
    default:
      return {
        label: role,
        isSynthesis: role.toLowerCase().includes("synthesis") || role.toLowerCase().includes("slm"),
      };
  }
}

function totalBytes(files: ModelFileRecord[]): number {
  return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

function GlassModelCard({
  model,
  selected,
  busyDelete,
  onDownload,
  onCancel,
  onDelete,
  onPrefer,
}: {
  model: CatalogItem;
  selected: boolean;
  busyDelete: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onPrefer: () => void;
}) {
  const Icon = model.isSynthesis ? Sparkles : AudioLines;
  const size = totalBytes(model.files);
  const friendly = FRIENDLY_NAMES[model.id];
  const isInstalled = model.status === "installed";
  const isDownloading = model.status === "downloading";

  return (
    <article
      aria-labelledby={`model-${model.id}-name`}
      className={cn(
        "panel group relative flex flex-col justify-between p-5 transition-all duration-200",
        isInstalled &&
          "border-accent-primary/25 bg-[color-mix(in_oklab,var(--brand-accent-primary)_4%,var(--glass-surface))]",
      )}
    >
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-2xl border transition-colors",
                isInstalled
                  ? "border-accent-primary/30 bg-accent-primary/14 text-accent-primary shadow-[0_0_20px_-4px_color-mix(in_oklab,var(--brand-accent-primary)_40%,transparent)]"
                  : "border-[var(--glass-border-strong)] bg-[var(--glass-surface-subtle)] text-text-muted",
              )}
            >
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3
                  id={`model-${model.id}-name`}
                  className="text-[15px] font-semibold tracking-[-0.015em] text-text-primary"
                >
                  {model.name}
                </h3>
                {friendly?.badge && !isInstalled && <Pill tone="accent">{friendly.badge}</Pill>}
                {!friendly?.badge && model.recommended && !isInstalled && (
                  <Pill tone="accent">Recommended</Pill>
                )}
                {selected && isInstalled && (
                  <Pill tone="accent" icon={<Check className="size-2.5" />}>
                    Active
                  </Pill>
                )}
                {!selected && isInstalled && (
                  <Pill tone="success" icon={<Check className="size-2.5" />}>
                    Ready
                  </Pill>
                )}
              </div>
              <p className="mt-0.5 text-[12px] font-medium text-text-muted">
                {friendly?.subtitle ?? model.roleLabel}
              </p>
            </div>
          </div>
          <span className="tabular shrink-0 rounded-full border border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] px-2.5 py-1 text-[11px] font-medium text-text-muted">
            {formatBytes(size)}
          </span>
        </div>

        <p className="mt-3.5 text-[12.5px] leading-[1.6] text-text-muted">
          {friendly?.summary ?? model.description}
        </p>
      </div>

      {isDownloading && (
        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
          <div className="mb-1.5 flex items-center justify-between text-[11.5px]">
            <span className="flex items-center gap-1.5 font-medium text-text-primary">
              <Loader2 className="size-3.5 animate-spin text-amber-400" aria-hidden="true" />
              Downloading…
            </span>
            <span className="tabular text-text-muted">
              {Math.round(model.progress)}% · {formatBytes((size * model.progress) / 100)}
            </span>
          </div>
          <ProgressBar
            value={model.progress}
            label={`${model.name} download progress`}
            size="xs"
            tone="warning"
          />
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-2 border-t border-[var(--glass-border)] pt-3.5">
        <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
          <Cpu className="size-3.5 text-accent-primary/80" aria-hidden="true" />
          <span>{model.accelerator.split("/")[0]?.trim() || "Local GPU"}</span>
          <span className="opacity-40">·</span>
          <span>{model.minRamGb} GB+ RAM</span>
        </span>

        <div className="flex items-center gap-1.5">
          {model.status === "available" && (
            <Button
              variant="primary"
              size="sm"
              leading={<Download className="size-3.5" />}
              onClick={onDownload}
            >
              Download
            </Button>
          )}
          {isDownloading && (
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {isInstalled && !selected && (
            <Button
              variant="secondary"
              size="sm"
              leading={<Sparkles className="size-3.5" />}
              onClick={onPrefer}
            >
              Set Active
            </Button>
          )}
          {isInstalled && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busyDelete}
              aria-label={`Remove ${model.name}`}
              title="Remove downloaded model from disk"
              className="flex size-8 items-center justify-center rounded-xl border border-transparent text-text-muted transition hover:border-recording-pulse/30 hover:bg-recording-pulse/10 hover:text-recording-pulse disabled:opacity-40"
            >
              {busyDelete ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-3.5" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function demoCatalogInitial(): CatalogItem[] {
  return DEMO_MODELS.map((m) => ({
    id: m.id,
    name: formatModelDisplayName(m.id),
    roleLabel: m.role,
    isSynthesis: m.role.toLowerCase().includes("synthesis"),
    repo: m.repo,
    description: m.description,
    files: m.files,
    accelerator: m.accelerator,
    minRamGb: m.minRamGb,
    recommended: m.recommended,
    status: m.status === "downloading" ? "available" : m.status,
    progress: m.status === "installed" ? 100 : 0,
    installedBytes: m.status === "installed" ? totalBytes(m.files) : 0,
  }));
}

export function ModelManager() {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const selectedModelId = useWorkspaceStore((state) => state.selectedModelId);
  const setSelectedModel = useWorkspaceStore((state) => state.setSelectedModel);
  const selectedAsrModelId = useWorkspaceStore((state) => state.selectedAsrModelId);
  const setSelectedAsrModel = useWorkspaceStore((state) => state.setSelectedAsrModel);

  const [native, setNative] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[]>(demoCatalogInitial);
  const [hardware, setHardware] = useState<HardwareProfileRecord | null>(null);
  const [modelsDir, setModelsDir] = useState<string>(
    `~/Library/Application Support/${BRAND.storageDirName}/models/`,
  );
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const [exportingDiag, setExportingDiag] = useState(false);
  const inFlightDownloads = useRef<Set<string>>(new Set());

  const refreshHub = useCallback(async () => {
    if (!isTauri()) return;
    const [hub, brandCfg] = await Promise.all([listModels(), getBrandConfig()]);
    if (brandCfg?.modelsDir) {
      setModelsDir(brandCfg.modelsDir);
    }
    if (!hub) return;
    setHardware(hub.hardware);
    setCatalog((prev) => {
      const prevMap = new Map(prev.map((item) => [item.id, item]));
      return hub.models.map((entry) => {
        const current = prevMap.get(entry.artifact.id);
        const isDownloading = inFlightDownloads.current.has(entry.artifact.id);
        const { label, isSynthesis } = roleLabelFor(entry.artifact.role);
        return {
          id: entry.artifact.id,
          name: formatModelDisplayName(entry.artifact.id),
          roleLabel: label,
          isSynthesis,
          repo: entry.artifact.repo,
          description: entry.artifact.description,
          files: entry.artifact.files,
          accelerator: entry.artifact.accelerator,
          minRamGb: entry.artifact.minRamGb,
          recommended: entry.artifact.recommended,
          status: entry.installed ? "installed" : isDownloading ? "downloading" : "available",
          progress: entry.installed ? 100 : isDownloading ? (current?.progress ?? 2) : 0,
          installedBytes: entry.installedBytes,
        };
      });
    });
  }, []);

  useEffect(() => {
    const hosted = isTauri();
    setNative(hosted);
    if (hosted) {
      void refreshHub();
    }
  }, [refreshHub]);

  useModelDownloadProgress((payload) => {
    setCatalog((previous) =>
      previous.map((item) => {
        if (item.id !== payload.artifactId) return item;
        const complete = payload.phase === "complete";
        return {
          ...item,
          status: complete ? "installed" : "downloading",
          progress: payload.percent,
          installedBytes: complete ? totalBytes(item.files) : payload.downloadedBytes,
        };
      }),
    );
  });

  const handleDownload = async (item: CatalogItem) => {
    if (inFlightDownloads.current.has(item.id)) return;
    const bytes = totalBytes(item.files);

    if (!native) {
      setCatalog((curr) =>
        curr.map((m) =>
          m.id === item.id
            ? { ...m, status: "installed", progress: 100, installedBytes: bytes }
            : m,
        ),
      );
      pushToast(`${item.name} ready`, formatBytes(bytes), "success");
      return;
    }

    inFlightDownloads.current.add(item.id);
    setCatalog((curr) =>
      curr.map((m) => (m.id === item.id ? { ...m, status: "downloading", progress: 1 } : m)),
    );
    pushToast(`Downloading ${item.name}`, `${formatBytes(bytes)} · verified locally`, "accent");

    try {
      const reports = await downloadModel(item.id);
      inFlightDownloads.current.delete(item.id);
      await refreshHub();
      const verifiedBytes = reports?.reduce((sum, r) => sum + r.bytes, 0) ?? bytes;
      pushToast(`${item.name} installed`, `${formatBytes(verifiedBytes)} ready for use`, "success");
    } catch (error) {
      inFlightDownloads.current.delete(item.id);
      await refreshHub();
      pushToast(`${item.name} download failed`, formatHostError(error), "danger");
    }
  };

  const handleCancelDownload = async (item: CatalogItem) => {
    if (!native) return;
    try {
      await cancelModelDownload(item.id);
      inFlightDownloads.current.delete(item.id);
      await refreshHub();
      pushToast(`Paused ${item.name}`, "Partial download kept to resume later.", "default");
    } catch (error) {
      pushToast(`Could not cancel ${item.name}`, formatHostError(error), "danger");
    }
  };

  const handleDelete = async (item: CatalogItem) => {
    if (deletingIds[item.id]) return;
    if (!native) {
      setCatalog((curr) =>
        curr.map((m) =>
          m.id === item.id ? { ...m, status: "available", progress: 0, installedBytes: 0 } : m,
        ),
      );
      pushToast(`Removed ${item.name}`, "Preview state reset.", "default");
      return;
    }

    setDeletingIds((curr) => ({ ...curr, [item.id]: true }));
    try {
      const freed = await deleteModel(item.id);
      await refreshHub();
      pushToast(
        `Removed ${item.name}`,
        `Freed ${formatBytes(freed ?? totalBytes(item.files))} on disk.`,
        "default",
      );
    } catch (error) {
      pushToast(`Could not remove ${item.name}`, formatHostError(error), "danger");
    } finally {
      setDeletingIds((curr) => ({ ...curr, [item.id]: false }));
    }
  };

  const handleExportDiagnostics = async () => {
    if (!native || exportingDiag) return;
    setExportingDiag(true);
    try {
      const outcome = await exportDiagnostics();
      if (outcome) {
        pushToast(
          "Diagnostics exported",
          `${outcome.path} (${outcome.logLines} log entries)`,
          "success",
        );
      }
    } catch (error) {
      pushToast("Diagnostics export failed", formatHostError(error), "danger");
    } finally {
      setExportingDiag(false);
    }
  };

  const speechModels = useMemo(
    () =>
      catalog
        .filter((item) => !item.isSynthesis)
        .sort((a, b) => (DISPLAY_ORDER[a.id] ?? 99) - (DISPLAY_ORDER[b.id] ?? 99)),
    [catalog],
  );
  const synthesisModels = useMemo(
    () =>
      catalog
        .filter((item) => item.isSynthesis)
        .sort((a, b) => (DISPLAY_ORDER[a.id] ?? 99) - (DISPLAY_ORDER[b.id] ?? 99)),
    [catalog],
  );
  const installedCount = useMemo(
    () => catalog.filter((item) => item.status === "installed").length,
    [catalog],
  );
  const installedBytes = useMemo(
    () =>
      catalog.reduce(
        (sum, item) =>
          item.status === "installed" ? sum + (item.installedBytes || totalBytes(item.files)) : sum,
        0,
      ),
    [catalog],
  );

  const ramDisplay = hardware
    ? hardware.ramGb > 0
      ? `${hardware.ramGb} GB RAM`
      : "Local RAM"
    : `${DEMO_HARDWARE.ramGb} GB RAM`;
  const accelDisplay = hardware ? hardware.accelerator : "Metal GPU";

  return (
    <AppShell rightMode="none">
      <div className="mx-auto w-full max-w-[1040px] px-5 pb-16 pt-8 sm:px-8 lg:pt-10">
        {/* Clean Glass Header */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Pill tone="accent" icon={<ShieldCheck className="size-3" />}>
                100% On-Device AI
              </Pill>
              <span className="tabular text-xs text-text-muted">
                {installedCount} of {catalog.length} installed · {formatBytes(installedBytes)}
              </span>
            </div>
            <h1 className="mt-2.5 text-[28px] font-semibold tracking-[-0.035em] text-text-primary sm:text-[32px]">
              AI Models
            </h1>
            <p className="mt-1.5 max-w-[540px] text-[13.5px] leading-6 text-text-muted">
              Download once to transcribe audio and generate grounded meeting summaries completely
              offline.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="glass-subtle hidden items-center gap-2 rounded-xl px-3 py-1.5 text-xs text-text-muted sm:inline-flex">
              <Cpu className="size-3.5 text-accent-primary" aria-hidden="true" />
              <span className="font-medium text-text-primary">{accelDisplay}</span>
              <span className="opacity-40">·</span>
              <span>{ramDisplay}</span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              leading={<RefreshCw className="size-3.5" />}
              onClick={() => {
                void refreshHub().then(() => {
                  pushToast("Models refreshed", "Synced with local model folder.", "success");
                });
              }}
            >
              Refresh
            </Button>
          </div>
        </header>

        {/* Section 1: Speech Recognition */}
        <section aria-labelledby="speech-models-heading" className="mt-8">
          <div className="mb-3.5 flex items-center justify-between">
            <div>
              <h2
                id="speech-models-heading"
                className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-text-primary"
              >
                <AudioLines className="size-4 text-accent-primary" aria-hidden="true" />
                Voice Recognition
              </h2>
              <p className="mt-0.5 text-xs text-text-muted">
                Converts live microphone and system audio into timestamped transcripts.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {speechModels.map((model) => (
              <GlassModelCard
                key={model.id}
                model={model}
                selected={selectedAsrModelId === model.id}
                busyDelete={Boolean(deletingIds[model.id])}
                onDownload={() => void handleDownload(model)}
                onCancel={() => void handleCancelDownload(model)}
                onDelete={() => void handleDelete(model)}
                onPrefer={() => {
                  setSelectedAsrModel(model.id);
                  pushToast(
                    `${model.name} set as active voice model`,
                    "Will be used for new recordings and transcriptions.",
                    "accent",
                  );
                }}
              />
            ))}
          </div>
        </section>

        {/* Section 2: Meeting Intelligence */}
        <section aria-labelledby="synthesis-models-heading" className="mt-8">
          <div className="mb-3.5 flex items-center justify-between">
            <div>
              <h2
                id="synthesis-models-heading"
                className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-text-primary"
              >
                <Sparkles className="size-4 text-accent-secondary" aria-hidden="true" />
                Meeting Summaries &amp; Action Items
              </h2>
              <p className="mt-0.5 text-xs text-text-muted">
                Synthesizes notes, decisions, and tasks with clickable source citations.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {synthesisModels.map((model) => (
              <GlassModelCard
                key={model.id}
                model={model}
                selected={selectedModelId === model.id}
                busyDelete={Boolean(deletingIds[model.id])}
                onDownload={() => void handleDownload(model)}
                onCancel={() => void handleCancelDownload(model)}
                onDelete={() => void handleDelete(model)}
                onPrefer={() => {
                  setSelectedModel(model.id);
                  pushToast(
                    `${model.name} set as active summary model`,
                    "Will be used for new meeting syntheses.",
                    "accent",
                  );
                }}
              />
            ))}
          </div>
        </section>

        {/* Collapsible Advanced & Storage Drawer */}
        <details className="panel group mt-8 overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 text-xs font-medium text-text-muted transition hover:text-text-primary">
            <span className="flex items-center gap-2">
              <HardDrive className="size-3.5 text-accent-primary" aria-hidden="true" />
              <span>Storage location &amp; system diagnostics</span>
              <span className="tabular text-text-muted/70">({formatBytes(installedBytes)})</span>
            </span>
            <ChevronDown
              className="size-4 transition-transform duration-200 group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--glass-border)] bg-[var(--glass-surface-subtle)] px-5 py-4 text-xs">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 font-medium text-text-primary">
                <FolderOpen className="size-3.5 text-text-muted" aria-hidden="true" />
                Local model directory
              </p>
              <p className="mt-1 truncate font-mono text-[11px] text-text-muted">{modelsDir}</p>
            </div>
            {native && (
              <Button
                variant="outline"
                size="sm"
                leading={
                  exportingDiag ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <FileJson className="size-3.5" />
                  )
                }
                disabled={exportingDiag}
                onClick={() => void handleExportDiagnostics()}
              >
                Export diagnostics
              </Button>
            )}
          </div>
        </details>
      </div>
    </AppShell>
  );
}
