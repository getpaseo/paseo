import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { i18n } from "@/i18n/i18next";
import { assertUnreachable } from "./exhaustive";

export function formatConnectionStatus(status: HostRuntimeConnectionStatus): string {
  switch (status) {
    case "online":
      return i18n.t("common.connectionStatus.online");
    case "connecting":
      return i18n.t("common.connectionStatus.connecting");
    case "offline":
      return i18n.t("common.connectionStatus.offline");
    case "error":
      return i18n.t("common.connectionStatus.error");
    case "idle":
      return i18n.t("common.connectionStatus.idle");
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
