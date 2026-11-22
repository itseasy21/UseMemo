"use client";

import { useState } from "react";
import { Camera, Expand, PencilLine, ScanText, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Pill } from "@/components/ui/Pill";
import { SlideThumbnail } from "@/components/ui/SlideThumbnail";
import { useBrand } from "@/components/providers/BrandProvider";
import type { Screenshot } from "@/lib/demo-data";
import { formatTimestamp } from "@/lib/format";
import { analyzeScreenshotOcr, deleteScreenshot, updateScreenshotOcr } from "@/lib/host";
import { formatHostError, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

export function ScreenshotCard({
  screenshot,
  onUpdatedOcr,
  onDeleted,
  className,
}: {
  screenshot: Screenshot;
  onUpdatedOcr?: (screenshotId: string, text: string) => void;
  onDeleted?: (screenshotId: string) => void;
  className?: string;
}) {
  const brand = useBrand();
  const pushToast = useWorkspaceStore((state) => state.pushToast);
  const [expanded, setExpanded] = useState(Boolean(screenshot.ocrExtractedText));
  const [editingOcr, setEditingOcr] = useState(false);
  const [ocrDraft, setOcrDraft] = useState(screenshot.ocrExtractedText ?? screenshot.slideText);
  const [saving, setSaving] = useState(false);
  const [runningOcr, setRunningOcr] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const effectiveText = screenshot.ocrExtractedText?.trim() || screenshot.slideText;

  const runOnDeviceOcr = async () => {
    if (!isTauri() || !screenshot.filePath) {
      pushToast("On-device OCR ready in desktop app", "Uses native Vision OCR offline.", "default");
      return;
    }
    setRunningOcr(true);
    try {
      const updated = await analyzeScreenshotOcr(screenshot.id);
      const extracted = updated?.ocrExtractedText?.trim() ?? "";
      if (extracted) {
        setOcrDraft(extracted);
        onUpdatedOcr?.(screenshot.id, extracted);
        setExpanded(true);
        pushToast(
          "Slide OCR complete",
          "Extracted slide text and indexed in SQLite FTS5.",
          "success",
        );
      } else {
        pushToast(
          "No legible text detected",
          "You can still add a manual slide caption.",
          "default",
        );
      }
    } catch (error) {
      pushToast("Slide OCR failed", formatHostError(error), "danger");
    } finally {
      setRunningOcr(false);
    }
  };

  const saveOcr = async () => {
    const trimmed = ocrDraft.trim();
    if (!isTauri() || screenshot.filePath === undefined) {
      onUpdatedOcr?.(screenshot.id, trimmed);
      setEditingOcr(false);
      setExpanded(true);
      return;
    }
    setSaving(true);
    try {
      await updateScreenshotOcr(screenshot.id, trimmed);
      onUpdatedOcr?.(screenshot.id, trimmed);
      setEditingOcr(false);
      setExpanded(true);
      pushToast("Slide text saved", "Indexed in SQLite FTS5 for synthesis citations.", "success");
    } catch (error) {
      pushToast("Could not save slide text", formatHostError(error), "danger");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (isTauri() && screenshot.filePath) {
      try {
        await deleteScreenshot(screenshot.id);
        onDeleted?.(screenshot.id);
        pushToast("Screenshot removed", "Deleted from SQLite and local media folder.", "default");
      } catch (error) {
        pushToast("Could not delete screenshot", formatHostError(error), "danger");
      }
      return;
    }
    onDeleted?.(screenshot.id);
  };

  return (
    <>
      <div
        className={cn(
          "overflow-hidden rounded-[7px] border border-border-subtle bg-bg-elevated/55",
          className,
        )}
      >
        <div className="flex items-center gap-1.5 border-b border-border-subtle bg-bg-primary/25 px-2.5 py-1.5">
          <Camera className="size-3 text-accent-secondary" aria-hidden="true" />
          <span className="text-[11px] font-medium text-text-primary">
            {screenshot.trigger === "manual" ? "Manual snap" : "Slide captured"}
          </span>
          <span className="text-[10px] text-text-muted">•</span>
          <span className="tabular text-[10.5px] text-text-muted">
            {formatTimestamp(screenshot.startMs)}
          </span>
          <Pill tone="secondary" className="ml-auto px-1.5 py-0">
            {screenshot.trigger === "slide-change" ? "vision trigger" : screenshot.trigger}
          </Pill>
        </div>

        <div className="flex gap-2.5 p-2.5">
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            aria-label={`Inspect ${screenshot.title} full size`}
            className="group relative w-[124px] shrink-0 self-start overflow-hidden rounded-[5px] focus-visible:outline-2"
          >
            <SlideThumbnail screenshot={screenshot} compact className="w-full" />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition group-hover:bg-black/35 group-hover:opacity-100">
              <Expand className="size-3.5" aria-hidden="true" />
            </span>
          </button>

          <div className="flex min-w-0 flex-1 flex-col">
            <p className="truncate text-[11.5px] font-medium text-text-primary">
              {screenshot.title}
            </p>
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-text-muted">
              {effectiveText}
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                className="inline-flex min-h-6 items-center gap-1 rounded-[5px] border border-border-subtle bg-bg-primary/40 px-2 text-[10.5px] font-medium text-text-muted transition hover:border-accent-secondary/30 hover:text-text-primary"
              >
                <ScanText className="size-3" aria-hidden="true" />
                {expanded ? "Hide slide text" : "View slide text"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOcrDraft(screenshot.ocrExtractedText ?? "");
                  setEditingOcr((prev) => !prev);
                  setExpanded(true);
                }}
                aria-label={`Edit text for ${screenshot.title}`}
                className="inline-flex min-h-6 items-center gap-1 rounded-[5px] border border-border-subtle bg-bg-primary/40 px-2 text-[10.5px] text-text-muted transition hover:text-text-primary"
              >
                <PencilLine className="size-3" aria-hidden="true" />
                Edit caption
              </button>
              {isTauri() && screenshot.filePath && brand.features.enableSlideVisionOCR && (
                <button
                  type="button"
                  disabled={runningOcr}
                  onClick={() => void runOnDeviceOcr()}
                  aria-label={`Run on-device OCR on ${screenshot.title}`}
                  className="inline-flex min-h-6 items-center gap-1 rounded-[5px] border border-border-subtle bg-bg-primary/40 px-2 text-[10.5px] text-text-muted transition hover:border-accent-primary/40 hover:text-text-primary disabled:opacity-50"
                >
                  <Sparkles className="size-3 text-accent-primary" aria-hidden="true" />
                  {runningOcr ? "Scanning…" : "OCR"}
                </button>
              )}
              {onDeleted && (
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  aria-label={`Delete screenshot at ${formatTimestamp(screenshot.startMs)}`}
                  className="inline-flex size-6 items-center justify-center rounded-[5px] text-text-muted transition hover:bg-recording-pulse/10 hover:text-recording-pulse"
                >
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              )}
              <span className="ml-auto hidden items-center gap-1 text-[10px] text-text-muted/65 sm:flex">
                <Sparkles className="size-2.5" aria-hidden="true" />
                WebP · deduped
              </span>
            </div>
          </div>
        </div>

        {expanded && (
          <div className="border-t border-border-subtle bg-bg-primary/30 px-2.5 py-2">
            <p className="mb-1 flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-accent-secondary">
              <ScanText className="size-3" aria-hidden="true" /> slide text · indexed for citations
            </p>
            {editingOcr ? (
              <div className="space-y-2">
                <textarea
                  value={ocrDraft}
                  onChange={(e) => setOcrDraft(e.target.value)}
                  aria-label="Slide OCR or caption text"
                  rows={3}
                  className="w-full rounded-[5px] border border-border-subtle bg-bg-primary/60 p-2 text-[11.5px] leading-5 text-text-primary outline-none focus:border-accent-primary/50"
                  placeholder="Describe or edit slide text so synthesis can cite [S-MM:SS]…"
                />
                <div className="flex justify-end gap-1.5">
                  <Button variant="ghost" size="xs" onClick={() => setEditingOcr(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="xs"
                    disabled={saving}
                    onClick={() => void saveOcr()}
                  >
                    {saving ? "Saving…" : "Save slide text"}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-[11px] leading-5 text-text-muted">
                {effectiveText}
              </p>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        title={`${screenshot.title} · ${formatTimestamp(screenshot.startMs)}`}
        description={screenshot.caption}
        size="xl"
      >
        <div className="space-y-3">
          <SlideThumbnail screenshot={screenshot} showTime={false} className="w-full" />
          <p className="whitespace-pre-wrap text-xs leading-5 text-text-muted">{effectiveText}</p>
        </div>
      </Dialog>
    </>
  );
}
