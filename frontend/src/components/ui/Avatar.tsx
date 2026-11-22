import type { SpeakerTone } from "@/lib/demo-data";
import { SPEAKER_STYLES } from "@/lib/display";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

const SIZES = {
  xs: "size-5 text-[8px]",
  sm: "size-6 text-[9px]",
  md: "size-7 text-[10px]",
  lg: "size-9 text-xs",
} as const;

export function Avatar({
  name,
  tone,
  size = "md",
  className,
  title,
}: {
  name: string;
  tone: SpeakerTone;
  size?: keyof typeof SIZES;
  className?: string;
  title?: string;
}) {
  return (
    <span
      aria-hidden="true"
      title={title ?? name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border font-semibold tracking-[0.02em]",
        SPEAKER_STYLES[tone].avatar,
        SIZES[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({
  people,
  max = 3,
  size = "sm",
}: {
  people: Array<{ name: string; tone: SpeakerTone }>;
  max?: number;
  size?: keyof typeof SIZES;
}) {
  const visible = people.slice(0, max);
  const extra = people.length - visible.length;
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {visible.map((person) => (
        <Avatar
          key={person.name}
          name={person.name}
          tone={person.tone}
          size={size}
          className="ring-2 ring-bg-primary"
        />
      ))}
      {extra > 0 && (
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full border border-border-subtle bg-bg-elevated font-medium text-text-muted ring-2 ring-bg-primary",
            SIZES[size],
          )}
          title={`${extra} more participants`}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
