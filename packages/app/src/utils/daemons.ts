import type { ConnectionStatus } from "@/contexts/daemon-connections-context";

export function formatConnectionStatus(status: ConnectionStatus): string {
  switch (status) {
    case "online":
      return "Online";
    case "connecting":
      return "Connecting";
    case "offline":
      return "Offline";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

export type ConnectionStatusTone = "success" | "warning" | "error" | "muted";

export function getConnectionStatusTone(status: ConnectionStatus): ConnectionStatusTone {
  switch (status) {
    case "online":
      return "success";
    case "connecting":
      return "warning";
    case "error":
      return "error";
    default:
      return "muted";
  }
}
