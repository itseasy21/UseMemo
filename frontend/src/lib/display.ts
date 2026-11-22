import type { SlidePalette, SpeakerTone } from "@/lib/demo-data";

export const SPEAKER_STYLES: Record<
  SpeakerTone,
  {
    pill: string;
    text: string;
    dot: string;
    avatar: string;
    soft: string;
    border: string;
  }
> = {
  accent: {
    pill: "border-accent-primary/25 bg-accent-primary/10 text-accent-primary",
    text: "text-accent-primary",
    dot: "bg-accent-primary",
    avatar: "border-accent-primary/30 bg-accent-primary/15 text-accent-primary",
    soft: "bg-accent-primary/[0.07]",
    border: "border-accent-primary/30",
  },
  secondary: {
    pill: "border-accent-secondary/25 bg-accent-secondary/10 text-accent-secondary",
    text: "text-accent-secondary",
    dot: "bg-accent-secondary",
    avatar: "border-accent-secondary/30 bg-accent-secondary/15 text-accent-secondary",
    soft: "bg-accent-secondary/[0.07]",
    border: "border-accent-secondary/30",
  },
  warm: {
    pill: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    text: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
    avatar: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    soft: "bg-amber-500/[0.06]",
    border: "border-amber-500/30",
  },
  violet: {
    pill: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    text: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
    avatar: "border-violet-500/30 bg-violet-500/15 text-violet-700 dark:text-violet-300",
    soft: "bg-violet-500/[0.06]",
    border: "border-violet-500/30",
  },
};

export function speakerBarColor(tone: SpeakerTone): string {
  switch (tone) {
    case "accent":
      return "var(--brand-accent-primary)";
    case "secondary":
      return "var(--brand-accent-secondary)";
    case "warm":
      return "oklch(0.74 0.14 75)";
    case "violet":
      return "oklch(0.66 0.14 300)";
  }
}

export function slideBackground(palette: SlidePalette): string {
  const accent =
    palette === "emerald"
      ? "var(--brand-accent-primary)"
      : palette === "indigo"
        ? "var(--brand-accent-secondary)"
        : palette === "amber"
          ? "oklch(0.74 0.14 75)"
          : palette === "violet"
            ? "oklch(0.66 0.14 300)"
            : "var(--brand-text-muted)";
  return [
    `radial-gradient(130% 110% at 8% 0%, color-mix(in oklch, ${accent} 34%, transparent) 0%, transparent 58%)`,
    `linear-gradient(145deg, color-mix(in oklch, ${accent} 13%, var(--brand-bg-elevated)) 0%, var(--brand-bg-primary) 72%)`,
  ].join(", ");
}

export function slideAccent(palette: SlidePalette): string {
  switch (palette) {
    case "emerald":
      return "var(--brand-accent-primary)";
    case "indigo":
      return "var(--brand-accent-secondary)";
    case "amber":
      return "oklch(0.74 0.14 75)";
    case "violet":
      return "oklch(0.66 0.14 300)";
    case "slate":
      return "var(--brand-text-muted)";
  }
}

export const WAVE_GRADIENT =
  "linear-gradient(90deg, var(--brand-accent-primary), var(--brand-accent-secondary))";
