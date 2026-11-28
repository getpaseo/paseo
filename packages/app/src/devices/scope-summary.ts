import { DAEMON_PERMISSIONS, type DaemonPermission } from "@getpaseo/protocol/messages";

const READ_ONLY_PERMISSIONS: ReadonlySet<DaemonPermission> = new Set([
  "daemon.read",
  "workspace.read",
]);

export type PermissionSummary =
  | { kind: "full" }
  | { kind: "read_only" }
  | { kind: "count"; count: number };

export function summarizePermissions(permissions: readonly DaemonPermission[]): PermissionSummary {
  const unique = new Set(permissions);
  if (unique.size >= DAEMON_PERMISSIONS.length) {
    return { kind: "full" };
  }
  if (unique.size > 0 && [...unique].every((permission) => READ_ONLY_PERMISSIONS.has(permission))) {
    return { kind: "read_only" };
  }
  return { kind: "count", count: unique.size };
}

export function formatConnectedDuration(
  isoTimestamp: string,
  nowMs = Date.now(),
): { kind: "just_now" } | { kind: "minutes" | "hours" | "days"; count: number } | null {
  const parsedMs = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsedMs)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - parsedMs) / 1000));
  if (elapsedSeconds < 60) return { kind: "just_now" };
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return { kind: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: "hours", count: hours };
  return { kind: "days", count: Math.floor(hours / 24) };
}
