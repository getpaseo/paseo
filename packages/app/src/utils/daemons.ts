import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { assertUnreachable } from "./exhaustive";

export function formatConnectionStatus(status: HostRuntimeConnectionStatus): string {
  switch (status) {
    case "online":
      return "Online";
    case "connecting":
      return "Connecting";
    case "offline":
      return "Offline";
    case "error":
      return "Error";
    case "idle":
      return "Idle";
    default:
      return assertUnreachable(status);
  }
}

export type ConnectionStatusTone = "success" | "warning" | "error" | "muted";

export function getConnectionStatusTone(
  status: HostRuntimeConnectionStatus
): ConnectionStatusTone {
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
