import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { assertUnreachable } from "./exhaustive";

export interface ConnectionStatusLabels {
  online: string;
  connecting: string;
  offline: string;
  error: string;
  idle: string;
}

const ENGLISH_CONNECTION_STATUS_LABELS: ConnectionStatusLabels = {
  online: "Online",
  connecting: "Connecting",
  offline: "Offline",
  error: "Error",
  idle: "Idle",
};

export function formatConnectionStatus(
  status: HostRuntimeConnectionStatus,
  labels: ConnectionStatusLabels = ENGLISH_CONNECTION_STATUS_LABELS,
): string {
  switch (status) {
    case "online":
      return labels.online;
    case "connecting":
      return labels.connecting;
    case "offline":
      return labels.offline;
    case "error":
      return labels.error;
    case "idle":
      return labels.idle;
    default:
      return assertUnreachable(status);
  }
}

export type ConnectionStatusTone = "success" | "warning" | "error" | "muted";

export function getConnectionStatusTone(status: HostRuntimeConnectionStatus): ConnectionStatusTone {
  switch (status) {
    case "online":
      return "success";
    case "connecting":
      return "warning";
    case "error":
      return "error";
    case "offline":
      return "warning";
    case "idle":
      return "muted";
    default:
      return assertUnreachable(status);
  }
}
