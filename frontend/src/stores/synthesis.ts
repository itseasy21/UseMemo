"use client";

import { create } from "zustand";

import type { EvidenceRef } from "@/lib/demo-data";

/**
 * Bidirectional evidence focus for the synthesis canvas.
 *
 * A synthesis item stores the evidence it was verified against. Hovering the
 * item sets `kind: "synthesis"` so the transcript/note preview can light up
 * every matching source. Hovering a preview row sets a concrete target, which
 * in turn lights up every synthesis item that cites it.
 */
export type SynthesisFocus =
  | { kind: "synthesis"; id: string; evidence: EvidenceRef[] }
  | { kind: "transcript"; id: string }
  | { kind: "note"; id: string }
  | { kind: "screenshot"; id: string };

type SynthesisState = {
  focus: SynthesisFocus | null;
  setFocus: (focus: SynthesisFocus) => void;
  clearFocus: () => void;
  clearFocusIf: (focus: SynthesisFocus) => void;
};

export const useSynthesisStore = create<SynthesisState>((set, get) => ({
  focus: null,
  setFocus: (focus) => set({ focus }),
  clearFocus: () => set({ focus: null }),
  clearFocusIf: (focus) => {
    const current = get().focus;
    if (current?.kind === focus.kind && current.id === focus.id) {
      set({ focus: null });
    }
  },
}));

export function evidenceIncludes(refs: EvidenceRef[], target: SynthesisFocus | null): boolean {
  if (!target) return false;
  if (target.kind === "synthesis") return false;
  return refs.some((ref) => ref.kind === target.kind && ref.id === target.id);
}

export function synthesisItemIsFocused(
  focus: SynthesisFocus | null,
  itemId: string,
  evidence: EvidenceRef[],
): boolean {
  if (!focus) return false;
  if (focus.kind === "synthesis") return focus.id === itemId;
  return evidenceIncludes(evidence, focus);
}
