/**
 * Format a date as a human-friendly relative time string
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "Jan 15"
 */
export function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 10) {
    return "just now";
  }

  if (diffMin < 1) {
    return `${diffSec}s ago`;
  }

  if (diffHour < 1) {
    return `${diffMin}m ago`;
  }

  if (diffDay < 1) {
    return `${diffHour}h ago`;
  }

  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }

  // For older dates, show abbreviated month and day
  const month = date.toLocaleDateString("en-US", { month: "short" });
  const day = date.getDate();
  return `${month} ${day}`;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Format a chat-message timestamp for hover-revealed UI.
 * - Same day: "10:11 PM"
 * - Within ~6 days: "Wednesday 10:11 PM"
 * - Older: "14 May 2026, 10:11 PM"
 */
export function formatMessageTimestamp(date: Date, now: Date = new Date()): string {
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  if (isSameLocalDay(date, now)) {
    return time;
  }

  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays >= 0 && diffDays < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
    return `${weekday} ${time}`;
  }

  const dateLabel = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${dateLabel}, ${time}`;
}

type DurationFormatMode = "static" | "live";

/**
 * Format a duration as a compact human-readable string.
 * - Static: integer units only
 * - Live: always keep one decimal in the smallest displayed unit
 */
export function formatDuration(
  durationMs: number,
  options?: { mode?: DurationFormatMode },
): string {
  const mode = options?.mode ?? "static";
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return mode === "live" ? "0.0s" : "0s";
  }
  const totalSeconds = durationMs / 1000;

  if (mode === "live") {
    if (totalSeconds < 60) {
      return `${totalSeconds.toFixed(1)}s`;
    }
    if (totalSeconds < 60 * 60) {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds - minutes * 60;
      return `${minutes}m ${seconds.toFixed(1)}s`;
    }
    const hours = Math.floor(totalSeconds / (60 * 60));
    const minutes = (totalSeconds - hours * 60 * 60) / 60;
    return `${hours}h ${minutes.toFixed(1)}m`;
  }

  const wholeSeconds = Math.floor(totalSeconds);
  if (wholeSeconds < 60) {
    return `${wholeSeconds}s`;
  }
  const minutes = Math.floor(wholeSeconds / 60);
  if (minutes < 60) {
    const seconds = wholeSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}
