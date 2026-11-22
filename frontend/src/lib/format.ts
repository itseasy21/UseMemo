/** Formatting helpers shared by every surface. All durations are milliseconds. */

export function pad2(value: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(2, "0");
}

/** `12:04` for short media, `1:02:04` once an hour is crossed. */
export function formatTimestamp(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

/** Always `mm:ss`, useful for compact players. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  return `${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}`;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(Math.max(0, ms) / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const precision = exponent === 0 ? 0 : value >= 100 ? 0 : decimals;
  return `${value.toFixed(precision)} ${units[exponent]}`;
}

export function formatMib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

export function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function initials(name: string): string {
  const parts = name
    .replace(/\(you\)/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function shortRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  if (!Number.isFinite(then)) return "unknown";
  const diffMinutes = Math.round((now - then) / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function trpcError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong locally.";
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
