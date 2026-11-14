"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BadgeCheck,
  Boxes,
  Check,
  Cpu,
  Download,
  FileCheck2,
  Gauge,
  HardDrive,
  Laptop,
  Loader2,
  LockKeyhole,
  MemoryStick,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
  WifiOff,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { AppShell } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { Meter } from "@/components/ui/Meter";
import { Pill } from "@/components/ui/Pill";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Toggle } from "@/components/ui/Toggle";
import { BRAND } from "@/generated/brand";
import { useModelDownloadProgress } from "@/hooks/use-host-event";
import { DEMO_HARDWARE, DEMO_MODELS, type DemoModel, type DemoModelStatus } from "@/lib/demo-data";
import { formatBytes } from "@/lib/format";
import { downloadModel, listModels } from "@/lib/host";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

type RuntimeState = {
  status: DemoModelStatus;
  progress: number;
  verified: boolean;
  enabled: boolean;
};

type ModelFilter = "all" | "installed" | "downloading" | "available";

const FILTERS: Array<{ id: ModelFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "installed", label: "Installed" },
  { id: "downloading", label: "Downloading" },
  { id: "available", label: "Available" },
];

const STATUS_TONE: Record<DemoModelStatus, "success" | "warning" | "outline"> = {
  installed: "success",
  downloading: "warning",
  available: "outline",
};

const ACCELERATOR_COLORS = {
  cpu: "var(--brand-accent-primary)",
  ram: "var(--brand-accent-secondary)",
  gpu: "oklch(0.68 0.15 250)",
  npu: "oklch(0.66 0.14 300)",
};

function initialState(): Record<string, RuntimeState> {
  return Object.fromEntries(
    DEMO_MODELS.map((model) => [
      model.id,
      {
        status: model.status,
        progress: model.downloadProgress,
        verified: model.verified,
        enabled: model.enabled,
      },
    ]),
  );
}

function modelIcon(model: DemoModel): LucideIcon {
  if (model.role.toLowerCase().includes("speech")) return Activity;
  if (model.role.toLowerCase().includes("diarization")) return Boxes;
  if (model.role.toLowerCase().includes("synthesis")) return Sparkles;
  return Cpu;
}

function totalBytes(model: DemoModel): number {
  return model.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

function StatusPill({ status }: { status: DemoModelStatus }) {
  if (status === "installed") {
    return (
      <Pill tone="success" className="gap-1" icon={<Check className="size-2.5" />}>
        Installed
      </Pill>
    );
  }
  if (status === "downloading") {
    return (
      <Pill tone="warning" className="gap-1" icon={<Download className="size-2.5" />}>
        Downloading
      </Pill>
    );
  }
  return <Pill tone="outline">Not downloaded</Pill>;
}

function MeterCard({
  label,
  detail,
  value,
  meter,
  icon: Icon,
  color,
}: {
  label: string;
  detail: string;
  value: string;
  meter: number;
  icon: LucideIcon;
  color: string;
}) {
  return (
    <div className="panel p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-text-muted">
          <Icon className="size-3 text-text-muted" />
          {label}
        </p>
        <span className="tabular text-[10px] text-text-primary">{Math.round(meter * 100)}%</span>
      </div>
      <p className="mt-1.5 truncate text-[11px] font-medium text-text-primary">{value}</p>
      <Meter
        value={meter}
        label={`${label} utilisation`}
        color={color}
        segments={16}
        className="mt-2 h-1.5"
      />
      <p className="mt-1.5 truncate text-[8px] text-text-muted/75">{detail}</p>
    </div>
  );
}

function ModelCard({
  model,
  state,
  selected,
  verifying,
  requireSha,
  onDownload,
  onVerify,
  onToggle,
  onPrefer,
}: {
  model: DemoModel;
  state: RuntimeState;
  selected: boolean;
  verifying: boolean;
  requireSha: boolean;
  onDownload: () => void;
  onVerify: () => void;
  onToggle: (enabled: boolean) => void;
  onPrefer: () => void;
}) {
  const Icon = modelIcon(model);
  const synthesis = model.role.toLowerCase().includes("synthesis");
  const size = totalBytes(model);
  const [primaryFile] = model.files;

  return (
    <article aria-labelledby={`model-${model.id}-name`} className="px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-[7px] border",
            state.status === "installed"
              ? "border-accent-primary/25 bg-accent-primary/10 text-accent-primary"
              : "border-border-subtle bg-bg-primary/40 text-text-muted",
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <h3
              id={`model-${model.id}-name`}
              className="text-[12.5px] font-semibold tracking-[-0.01em] text-text-primary"
            >
              {model.name}
            </h3>
            {model.recommended && <Pill tone="accent">Recommended</Pill>}
            {synthesis && selected && <Pill tone="secondary">Synthesis default</Pill>}
            <StatusPill status={state.status} />
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[8.5px] text-text-muted">
            <span className="font-semibold uppercase tracking-[0.1em]">{model.role}</span>
            <span className="text-border-subtle">·</span>
            <span className="truncate font-mono text-[8px]">{model.repo}</span>
          </p>
          <p className="mt-1.5 max-w-[720px] text-[10.5px] leading-5 text-text-muted">
            {model.description}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Toggle
            checked={state.enabled}
            onChange={onToggle}
            label={`Enable ${model.name}`}
            disabled={state.status === "available"}
            size="sm"
          />
          <span className="w-11 text-[8px] uppercase tracking-[0.06em] text-text-muted">
            {state.enabled ? "enabled" : "off"}
          </span>
        </div>
      </div>

      <div className="mt-2.5 space-y-1 border-t border-border-subtle/70 pt-2.5">
        {model.files.map((file) => (
          <div key={file.filename} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <FileCheck2 className="size-2.5 shrink-0 text-text-muted/70" />
            <span className="min-w-0 max-w-full truncate font-mono text-[8.5px] text-text-primary/80">
              {file.filename}
            </span>
            <span className="tabular shrink-0 text-[8px] text-text-muted/75">
              {formatBytes(file.sizeBytes)}
            </span>
            <span
              title={`SHA-256 ${file.sha256}`}
              className="tabular shrink-0 rounded border border-border-subtle bg-bg-primary/35 px-1 py-px font-mono text-[7px] text-text-muted"
            >
              sha256:{file.sha256.slice(0, 10)}…
            </span>
            {state.status === "installed" ? (
              state.verified ? (
                <span className="flex items-center gap-1 text-[7.5px] text-accent-primary">
                  <BadgeCheck className="size-2.5" /> verified
                </span>
              ) : (
                <Pill tone="warning" className="px-1.5 py-0">
                  hash unverified
                </Pill>
              )
            ) : (
              <Pill tone="outline" className="px-1.5 py-0">
                {state.status === "downloading"
                  ? `${Math.round(state.progress)}% fetched`
                  : "remote"}
              </Pill>
            )}
          </div>
        ))}
      </div>

      {state.status === "downloading" && (
        <div className="mt-2.5 rounded-[6px] border border-amber-500/25 bg-amber-500/[0.055] p-2.5">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[8.5px]">
            <span className="flex items-center gap-1.5 font-medium text-text-primary">
              <Loader2 className="size-2.5 animate-spin text-amber-600 dark:text-amber-300" />
              Fetching {primaryFile.filename}
            </span>
            <span className="tabular text-text-muted">
              {Math.round(state.progress)}% · {formatBytes((size * state.progress) / 100)} /{" "}
              {formatBytes(size)} · {model.speedMbps || 42.6} MB/s
            </span>
          </div>
          <ProgressBar
            value={state.progress}
            label={`${model.name} download progress`}
            size="xs"
            tone="warning"
          />
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Pill tone="outline" className="gap-1">
          <Zap className="size-2.5" />
          {model.accelerator}
        </Pill>
        <Pill tone="outline" className="gap-1">
          <MemoryStick className="size-2.5" />
          {model.minRamGb} GB RAM min
        </Pill>
        <span className="tabular text-[8px] text-text-muted/65">
          {model.files.length} {model.files.length === 1 ? "artifact" : "artifacts"} ·{" "}
          {formatBytes(size)}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {state.status === "available" && (
            <Button
              variant="primary"
              size="xs"
              leading={<Download className="size-3" />}
              onClick={onDownload}
            >
              Download
            </Button>
          )}
          {state.status === "downloading" && (
            <Button
              variant="secondary"
              size="xs"
              leading={<Download className="size-3" />}
              onClick={onDownload}
              disabled
            >
              Downloading…
            </Button>
          )}
          {state.status === "installed" && (
            <Button
              variant={state.verified ? "ghost" : "primary"}
              size="xs"
              leading={
                verifying ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <ShieldCheck className="size-3" />
                )
              }
              onClick={onVerify}
              disabled={verifying}
            >
              {verifying ? "Hashing…" : state.verified ? "Re-verify" : "Verify SHA-256"}
            </Button>
          )}
          {synthesis && (
            <Button
              variant={selected ? "secondary" : "outline"}
              size="xs"
              leading={<Sparkles className="size-3" />}
              onClick={onPrefer}
              disabled={selected || state.status !== "installed"}
            >
              {selected ? "In use" : "Set default"}
            </Button>
          )}
        </div>
      </div>

      {!requireSha && !state.verified && state.status === "installed" && (
        <p className="mt-2 flex items-center gap-1.5 rounded-[5px] border border-recording-pulse/25 bg-recording-pulse/[0.05] px-2 py-1 text-[8px] text-recording-pulse">
          <WifiOff className="size-2.5" />
          Load will fall back to hash verification because the app-level gate is disabled.
        </p>
      )}
    </article>
  );
}

export function ModelManager() {
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const selectedModelId = useWorkspaceStore((state) => state.selectedModelId);
  const setSelectedModel = useWorkspaceStore((state) => state.setSelectedModel);

  const [models, setModels] = useState<Record<string, RuntimeState>>(initialState);
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});
  const [requireSha, setRequireSha] = useState(true);
  const [meters, setMeters] = useState<Record<string, number>>({
    ...DEMO_HARDWARE.usage,
  });
  const downloadTimers = useRef<Map<string, number>>(new Map());
  const completionTimeouts = useRef<Set<number>>(new Set());
  const completed = useRef<Set<string>>(new Set());
  const hostDownloads = useRef<Set<string>>(new Set());
  const autoStarted = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    void listModels().then((hub) => {
      if (!hub) return;
      setModels((previous) => {
        const next = { ...previous };
        for (const status of hub.models) {
          const current = next[status.artifact.id];
          next[status.artifact.id] = {
            status: status.installed ? "installed" : "available",
            progress: status.installed ? 100 : 0,
            verified: status.installed,
            enabled: current?.enabled ?? status.installed,
          };
        }
        return next;
      });
    });
  }, []);

  useModelDownloadProgress((payload) => {
    setModels((previous) => {
      const current = previous[payload.artifactId];
      if (!current) return previous;
      const complete = payload.phase === "complete";
      return {
        ...previous,
        [payload.artifactId]: {
          ...current,
          status: complete ? "installed" : "downloading",
          progress: payload.percent,
          verified: complete,
        },
      };
    });
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMeters((previous) => ({
        cpu: Math.min(0.86, Math.max(0.07, previous.cpu + (Math.random() - 0.5) * 0.07)),
        ram: Math.min(0.9, Math.max(0.24, previous.ram + (Math.random() - 0.5) * 0.025)),
        gpu: Math.min(0.82, Math.max(0.03, previous.gpu + (Math.random() - 0.5) * 0.09)),
        npu: Math.min(0.78, Math.max(0.01, previous.npu + (Math.random() - 0.5) * 0.08)),
      }));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timers = downloadTimers.current;
    const timeouts = completionTimeouts.current;
    return () => {
      timers.forEach((timer) => window.clearInterval(timer));
      timers.clear();
      timeouts.forEach((timeout) => window.clearTimeout(timeout));
      timeouts.clear();
    };
  }, []);

  const startDownload = (model: DemoModel) => {
    if (downloadTimers.current.has(model.id) || hostDownloads.current.has(model.id)) return;
    const size = totalBytes(model);
    setModels((previous) => ({
      ...previous,
      [model.id]: {
        ...previous[model.id],
        status: "downloading",
        progress: previous[model.id].progress >= 100 ? 0 : previous[model.id].progress,
      },
    }));
    pushToast(
      `Fetching ${model.name}`,
      `${model.files[0]?.filename ?? "artifact"} · ${formatBytes(size)} · SHA-256 pinned`,
      "accent",
    );

    if (isTauri()) {
      hostDownloads.current.add(model.id);
      void downloadModel(model.id).then((reports) => {
        hostDownloads.current.delete(model.id);
        if (!reports) {
          setModels((previous) => ({
            ...previous,
            [model.id]: {
              ...previous[model.id],
              status: "available",
              progress: 0,
              verified: false,
            },
          }));
          pushToast(
            `${model.name} download failed`,
            "No bytes were loaded. Check the local model cache and retry.",
            "danger",
          );
          return;
        }
        setModels((previous) => ({
          ...previous,
          [model.id]: {
            ...previous[model.id],
            status: "installed",
            progress: 100,
            enabled: true,
            verified: true,
          },
        }));
        pushToast(
          `${model.name} installed`,
          `${formatBytes(reports.reduce((sum, report) => sum + report.bytes, 0))} verified with SHA-256`,
          "success",
        );
      });
      return;
    }

    const timer = window.setInterval(() => {
      setModels((previous) => {
        const current = previous[model.id];
        if (!current || current.status !== "downloading") {
          window.clearInterval(timer);
          downloadTimers.current.delete(model.id);
          return previous;
        }
        const progress = Math.min(100, current.progress + 4.4);
        if (progress >= 100) {
          window.clearInterval(timer);
          downloadTimers.current.delete(model.id);
          if (!completed.current.has(model.id)) {
            completed.current.add(model.id);
            const timeout = window.setTimeout(() => {
              pushToast(
                `${model.name} installed`,
                `${formatBytes(size)} written to the local model cache · verify the SHA-256 before load`,
                "success",
              );
            }, 0);
            completionTimeouts.current.add(timeout);
          }
          return {
            ...previous,
            [model.id]: {
              ...current,
              status: "installed",
              progress: 100,
              enabled: true,
              verified: false,
            },
          };
        }
        return { ...previous, [model.id]: { ...current, progress } };
      });
    }, 420);

    downloadTimers.current.set(model.id, timer);
  };

  useEffect(() => {
    if (autoStarted.current || isTauri()) return;
    autoStarted.current = true;
    for (const model of DEMO_MODELS) {
      if (model.status === "downloading") startDownload(model);
    }
    // The browser preview resumes the pinned in-flight artifact once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verifyModel = (model: DemoModel) => {
    if (verifying[model.id]) return;
    setVerifying((previous) => ({ ...previous, [model.id]: true }));
    const timeout = window.setTimeout(() => {
      setVerifying((previous) => ({ ...previous, [model.id]: false }));
      setModels((previous) => ({
        ...previous,
        [model.id]: { ...previous[model.id], verified: true, status: "installed" },
      }));
      pushToast(
        `${model.name} verified`,
        `SHA-256 matches ${model.files[0]?.sha256.slice(0, 20) ?? "manifest"}… · loaded locally`,
        "success",
      );
    }, 950);
    completionTimeouts.current.add(timeout);
  };

  const toggleModel = (model: DemoModel, enabled: boolean) => {
    setModels((previous) => ({
      ...previous,
      [model.id]: { ...previous[model.id], enabled },
    }));
    pushToast(
      `${model.name} ${enabled ? "enabled" : "disabled"}`,
      enabled
        ? "Resident in the local LiteRT runtime"
        : "Unloaded from memory · artifact kept on disk",
      enabled ? "success" : "default",
    );
  };

  const preferModel = (model: DemoModel) => {
    if (selectedModelId === model.id) return;
    setSelectedModel(model.id);
    pushToast(
      `${model.name} is now the synthesis default`,
      "Applied to future local synthesis runs · nothing leaves the device",
      "accent",
    );
  };

  const counts = useMemo(() => {
    const result: Record<ModelFilter, number> = {
      all: DEMO_MODELS.length,
      installed: 0,
      downloading: 0,
      available: 0,
    };
    for (const model of DEMO_MODELS) {
      const status = models[model.id]?.status ?? model.status;
      result[status] += 1;
    }
    return result;
  }, [models]);

  const visibleModels = DEMO_MODELS.filter((model) => {
    const status = models[model.id]?.status ?? model.status;
    return filter === "all" || status === filter;
  });

  const installedBytes = DEMO_MODELS.reduce(
    (sum, model) => (models[model.id]?.status === "installed" ? sum + totalBytes(model) : sum),
    0,
  );
  const installedCount = DEMO_MODELS.filter(
    (model) => models[model.id]?.status === "installed",
  ).length;
  const cachePath = `~/Library/Application Support/${BRAND.storageDirName}/models/`;
  const diskPercent = Math.min(100, (installedBytes / (5 * 1024 ** 3)) * 100);

  return (
    <AppShell>
      <div className="sticky top-0 z-20 border-b border-border-subtle bg-bg-primary/85 backdrop-blur-md">
        <div className="mx-auto flex h-12 max-w-[1280px] items-center gap-2.5 px-5 lg:px-7">
          <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-text-muted">
            <HardDrive className="size-3 text-text-muted/70" />
            <span>Local vault</span>
            <span className="text-text-muted/40">/</span>
            <span className="text-text-primary">Models</span>
          </div>
          <Pill
            tone="accent"
            className="ml-1 hidden gap-1 sm:inline-flex"
            icon={<ShieldCheck className="size-2.5" />}
          >
            Air-gap enforced
          </Pill>
          <div className="ml-auto flex items-center gap-2">
            <span className="tabular hidden text-[9px] text-text-muted sm:inline">
              {installedCount}/{DEMO_MODELS.length} pinned · {formatBytes(installedBytes)}
            </span>
            <Pill tone="neutral" className="gap-1" icon={<Cpu className="size-2.5" />}>
              LiteRT
            </Pill>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1280px] px-5 pb-16 pt-5 lg:px-7">
        <section className="relative overflow-hidden rounded-[12px] border border-border-subtle bg-[radial-gradient(110%_130%_at_0%_0%,color-mix(in_oklch,var(--brand-accent-secondary)_11%,transparent),transparent_58%)] p-5 lg:p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-[640px]">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="neutral" className="gap-1.5">
                  <span className="size-1 rounded-full bg-accent-primary" />
                  {BRAND.productName} · local inference
                </Pill>
                <Pill tone="outline" icon={<LockKeyhole className="size-2.5" />}>
                  no egress
                </Pill>
                <Pill tone="outline">QAT INT4 / INT8</Pill>
              </div>
              <h1 className="mt-3 text-[26px] font-semibold leading-[1.1] tracking-[-0.04em] text-text-primary sm:text-[30px]">
                Models that never phone home.
              </h1>
              <p className="mt-2 max-w-[560px] text-[12px] leading-6 text-text-muted">
                Five pinned artifacts power speech, diarization, and synthesis on this machine.
                Downloads are explicit, hashed, and never load before verification.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="md"
                  leading={<Upload className="size-3.5" />}
                  onClick={() =>
                    pushToast(
                      "Manual artifact import",
                      "Drop a .litertlm file into the vault · hashes are checked before the runtime sees it",
                      "accent",
                    )
                  }
                >
                  Import artifact
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  leading={<RefreshCw className="size-3.5" />}
                  onClick={() =>
                    pushToast(
                      "Manifest re-checked",
                      `${DEMO_MODELS.length} pinned artifacts · SHA-256 manifest unchanged · offline`,
                      "success",
                    )
                  }
                >
                  Re-check manifest
                </Button>
                <span className="ml-1 flex items-center gap-1.5 text-[9px] text-text-muted">
                  <WifiOff className="size-3" />
                  network disabled at the process boundary
                </span>
              </div>
            </div>

            <div className="hidden w-[244px] shrink-0 rounded-brand border border-border-subtle bg-bg-primary/45 p-3.5 backdrop-blur-sm sm:block">
              <p className="flex items-center gap-1.5 text-[8.5px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                <PackageCheck className="size-3 text-accent-primary" />
                Local footprint
              </p>
              <p className="tabular mt-1.5 text-[24px] font-medium leading-none tracking-[-0.03em] text-text-primary">
                {formatBytes(installedBytes)}
              </p>
              <p className="mt-1 text-[9px] text-text-muted">
                {installedCount} installed · {counts.downloading} in flight
              </p>
              <div className="mt-3 space-y-1.5 border-t border-border-subtle pt-2.5 text-[8.5px]">
                <p className="flex items-center justify-between gap-2">
                  <span className="text-text-muted">Runtime</span>
                  <span className="font-mono text-text-primary/80">LiteRT · Metal</span>
                </p>
                <p className="flex items-center justify-between gap-2">
                  <span className="text-text-muted">Hardware tier</span>
                  <span className="font-mono text-text-primary/80">{DEMO_HARDWARE.tier}</span>
                </p>
                <p className="flex items-center justify-between gap-2">
                  <span className="text-text-muted">Hash gate</span>
                  <span
                    className={cn(
                      "font-mono",
                      requireSha ? "text-accent-primary" : "text-recording-pulse",
                    )}
                  >
                    {requireSha ? "required" : "disabled"}
                  </span>
                </p>
              </div>
            </div>
          </div>
        </section>

        <section
          aria-label="Hardware meters"
          className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        >
          <MeterCard
            label="CPU"
            value={DEMO_HARDWARE.cpu}
            detail="8 cores · 6 performance + 2 efficiency"
            meter={meters.cpu}
            icon={Cpu}
            color={ACCELERATOR_COLORS.cpu}
          />
          <MeterCard
            label="Memory"
            value={`${Math.round(DEMO_HARDWARE.ramGb * meters.ram)} / ${DEMO_HARDWARE.ramGb} GB`}
            detail="Unified memory · Metal shared allocation"
            meter={meters.ram}
            icon={MemoryStick}
            color={ACCELERATOR_COLORS.ram}
          />
          <MeterCard
            label="GPU"
            value={DEMO_HARDWARE.gpu}
            detail="Metal 3 · 16 cores"
            meter={meters.gpu}
            icon={Gauge}
            color={ACCELERATOR_COLORS.gpu}
          />
          <MeterCard
            label="Neural Engine"
            value={DEMO_HARDWARE.npu}
            detail="Core ML · ANE delegate"
            meter={meters.npu}
            icon={Zap}
            color={ACCELERATOR_COLORS.npu}
          />
        </section>

        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_332px]">
          <section aria-labelledby="artifacts-heading" className="panel overflow-hidden">
            <header className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2
                  id="artifacts-heading"
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                >
                  <Boxes className="size-3.5 text-text-muted" />
                  Local artifacts
                </h2>
                <p className="mt-0.5 text-[9px] text-text-muted">
                  {counts.installed} installed · {counts.downloading} downloading ·{" "}
                  {counts.available} available · {DEMO_MODELS.length} total
                </p>
              </div>
              <div
                role="group"
                aria-label="Filter models"
                className="flex h-6 items-center rounded-[6px] border border-border-subtle bg-bg-primary/40 p-0.5"
              >
                {FILTERS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={filter === option.id}
                    onClick={() => setFilter(option.id)}
                    className={cn(
                      "flex h-5 items-center gap-1 rounded-[4px] px-2 text-[9px] font-medium transition",
                      filter === option.id
                        ? "bg-bg-elevated text-text-primary shadow-sm"
                        : "text-text-muted hover:text-text-primary",
                    )}
                  >
                    {option.label}
                    <span className="tabular text-[7.5px] opacity-60">{counts[option.id]}</span>
                  </button>
                ))}
              </div>
            </header>

            <div className="divide-y divide-border-subtle/70">
              {visibleModels.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                  <PackageCheck className="mb-3 size-6 text-text-muted/50" />
                  <p className="text-[11px] font-medium text-text-primary">
                    No artifacts in this state
                  </p>
                  <p className="mt-1 text-[9.5px] text-text-muted">
                    Switch the filter or fetch a pinned artifact from the local cache.
                  </p>
                </div>
              ) : (
                visibleModels.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    state={models[model.id]}
                    selected={selectedModelId === model.id}
                    verifying={Boolean(verifying[model.id])}
                    requireSha={requireSha}
                    onDownload={() => startDownload(model)}
                    onVerify={() => verifyModel(model)}
                    onToggle={(enabled) => toggleModel(model, enabled)}
                    onPrefer={() => preferModel(model)}
                  />
                ))
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-bg-primary/25 px-4 py-2 text-[8px] text-text-muted/70">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="size-2.5 text-accent-primary" />
                Every artifact is hashed before it reaches the runtime.
              </span>
              <span className="font-mono">sha256 manifest · local cache</span>
            </footer>
          </section>

          <aside className="min-w-0 space-y-3">
            <section aria-labelledby="host-heading" className="panel p-4">
              <div className="flex items-center justify-between gap-2">
                <h2
                  id="host-heading"
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                >
                  <Laptop className="size-3.5 text-text-muted" />
                  Host
                </h2>
                <Pill tone="accent">{DEMO_HARDWARE.tier} tier</Pill>
              </div>
              <p className="mt-2 text-[12px] font-medium text-text-primary">{DEMO_HARDWARE.host}</p>
              <p className="text-[9px] text-text-muted">{DEMO_HARDWARE.os}</p>
              <dl className="mt-2.5 space-y-1.5 border-t border-border-subtle pt-2.5 text-[8.5px]">
                {[
                  ["CPU", DEMO_HARDWARE.cpu],
                  ["GPU", DEMO_HARDWARE.gpu],
                  ["Neural Engine", DEMO_HARDWARE.npu],
                  ["Memory", `${DEMO_HARDWARE.ramGb} GB unified`],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-start justify-between gap-3">
                    <dt className="text-text-muted">{label}</dt>
                    <dd className="text-right font-mono text-[8px] leading-4 text-text-primary/80">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-2 flex flex-wrap gap-1">
                {DEMO_HARDWARE.accelerators.map((accelerator) => (
                  <Pill key={accelerator} tone="outline">
                    {accelerator}
                  </Pill>
                ))}
              </div>
            </section>

            <section aria-labelledby="storage-heading" className="panel p-4">
              <div className="flex items-center justify-between gap-2">
                <h2
                  id="storage-heading"
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                >
                  <HardDrive className="size-3.5 text-text-muted" />
                  Model cache
                </h2>
                <span className="tabular text-[9px] text-text-muted">
                  {Math.round(diskPercent)}% of 5 GB
                </span>
              </div>
              <p className="tabular mt-2 text-[20px] font-medium leading-none tracking-[-0.03em] text-text-primary">
                {formatBytes(installedBytes)}
              </p>
              <ProgressBar
                value={diskPercent}
                label="Model cache usage"
                size="sm"
                className="mt-2.5"
              />
              <p className="mt-2 break-all font-mono text-[7.5px] leading-4 text-text-muted/70">
                {cachePath}
              </p>
              <p className="mt-1.5 text-[8.5px] leading-4 text-text-muted">
                {installedCount} installed artifacts · {counts.downloading} download in progress ·
                cache is prunable without touching memos
              </p>
            </section>

            <section aria-labelledby="airgap-heading" className="panel overflow-hidden">
              <header className="border-b border-border-subtle px-4 py-3">
                <h2
                  id="airgap-heading"
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                >
                  <ShieldCheck className="size-3.5 text-accent-primary" />
                  Integrity &amp; air gap
                </h2>
                <p className="mt-0.5 text-[8.5px] text-text-muted">
                  {BRAND.productName} fails closed, not open.
                </p>
              </header>
              <div className="divide-y divide-border-subtle/70">
                {[
                  {
                    id: "offline",
                    label: "Enforce offline mode",
                    detail: "Process-level egress block · locked by build policy",
                    checked: true,
                    disabled: true,
                  },
                  {
                    id: "digest",
                    label: "Require SHA-256 before load",
                    detail: "Reject any artifact whose digest differs from the manifest",
                    checked: requireSha,
                    disabled: false,
                  },
                  {
                    id: "metadata",
                    label: "Allow remote metadata checks",
                    detail: "Always off · registry metadata ships with the app",
                    checked: false,
                    disabled: true,
                  },
                  {
                    id: "meters",
                    label: "Runtime meters",
                    detail: "No counters leave the vault",
                    checked: false,
                    disabled: true,
                  },
                ].map((row) => (
                  <div key={row.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[9.5px] font-medium text-text-primary">{row.label}</p>
                      <p className="mt-0.5 text-[8px] leading-4 text-text-muted">{row.detail}</p>
                    </div>
                    <Toggle
                      checked={row.checked}
                      disabled={row.disabled}
                      onChange={(next) => {
                        setRequireSha(next);
                        pushToast(
                          next ? "Hash gate enabled" : "Hash gate disabled",
                          next
                            ? "Artifacts must match the pinned SHA-256 manifest before load"
                            : "The runtime will still verify on load, but the UI gate is off",
                          next ? "success" : "danger",
                        );
                      }}
                      label={row.label}
                      size="sm"
                    />
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-1.5 border-t border-border-subtle bg-accent-primary/[0.045] px-4 py-2 text-[8px] text-text-muted">
                <LockKeyhole className="size-2.5 text-accent-primary" />
                Model downloads are the only network path, and they are explicit.
              </div>
            </section>

            <section aria-labelledby="runtime-heading" className="panel p-4">
              <div className="flex items-center justify-between gap-2">
                <h2
                  id="runtime-heading"
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary"
                >
                  <Cpu className="size-3.5 text-text-muted" />
                  Runtime
                </h2>
                <span className="flex items-center gap-1 text-[8px] text-accent-primary">
                  <span className="size-1 rounded-full bg-accent-primary" />
                  ready
                </span>
              </div>
              <dl className="mt-2.5 space-y-1.5 text-[8.5px]">
                {[
                  ["Engine", "LiteRT · local"],
                  ["Delegates", "Metal · XNNPACK · ANE"],
                  [
                    "Selected SLM",
                    DEMO_MODELS.find((m) => m.id === selectedModelId)?.name ?? "none",
                  ],
                  ["Streaming latency", "640 ms · ASR"],
                  ["Verifier", "fail-closed · local"],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-start justify-between gap-3">
                    <dt className="text-text-muted">{label}</dt>
                    <dd className="max-w-[180px] truncate text-right font-mono text-[8px] text-text-primary/80">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-2 flex items-center gap-1.5 border-t border-border-subtle pt-2 text-[8px] text-text-muted/70">
                <Kbd>⌘K</Kbd>
                switch models from the command palette
              </div>
            </section>
          </aside>
        </div>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-4 text-[9px] text-text-muted/70">
          <span>
            {BRAND.productName} · {BRAND.licenseType} · {BRAND.modelRegistry.hfBaseUrl}
          </span>
          <span className="flex items-center gap-1.5">
            <Sparkles className="size-2.5 text-accent-primary" />
            Artifacts pinned by SHA-256 · runtime fully local
          </span>
        </footer>
      </div>
    </AppShell>
  );
}
