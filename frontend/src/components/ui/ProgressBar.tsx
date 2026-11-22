import { cn } from "@/lib/utils";

export function ProgressBar({
  value,
  label,
  className,
  barClassName,
  size = "md",
  tone = "accent",
}: {
  value: number;
  label: string;
  className?: string;
  barClassName?: string;
  size?: "xs" | "sm" | "md";
  tone?: "accent" | "secondary" | "warning";
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const fill =
    tone === "accent"
      ? "bg-accent-primary"
      : tone === "secondary"
        ? "bg-accent-secondary"
        : "bg-amber-500";
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-full bg-border-subtle/70",
        size === "xs" && "h-1",
        size === "sm" && "h-1.5",
        size === "md" && "h-2",
        className,
      )}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-300", fill, barClassName)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
