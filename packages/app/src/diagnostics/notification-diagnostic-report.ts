import { getDesktopHost } from "@/desktop/host";
import { isNative, isWeb } from "@/constants/platform";
import { formatDiagnosticSection } from "./app-diagnostic-report";

export interface NotificationDiagnosticSnapshot {
  isWeb: boolean;
  isNative: boolean;
  desktopBridge: "available" | "unavailable";
  notificationApi: "available" | "unavailable";
  permission: string;
  serviceWorker: "available" | "unavailable";
}

export interface NotificationDiagnosticEnvironment {
  isWeb: boolean;
  isNative: boolean;
  hasDesktopBridge: () => boolean;
  getNotificationPermission: () => string | null;
  hasServiceWorker: () => boolean;
}

export function collectNotificationDiagnosticSnapshot(
  env: NotificationDiagnosticEnvironment = defaultNotificationDiagnosticEnvironment,
): NotificationDiagnosticSnapshot {
  const permission = env.getNotificationPermission();
  return {
    isWeb: env.isWeb,
    isNative: env.isNative,
    desktopBridge: env.hasDesktopBridge() ? "available" : "unavailable",
    notificationApi: permission === null ? "unavailable" : "available",
    permission: permission ?? "unavailable",
    serviceWorker: env.hasServiceWorker() ? "available" : "unavailable",
  };
}

export function formatNotificationDiagnosticSection(
  snapshot: NotificationDiagnosticSnapshot,
): string {
  return formatDiagnosticSection("Notifications", [
    { label: "Web runtime", value: snapshot.isWeb ? "yes" : "no" },
    { label: "Native runtime", value: snapshot.isNative ? "yes" : "no" },
    { label: "Desktop bridge", value: snapshot.desktopBridge },
    { label: "Notification API", value: snapshot.notificationApi },
    { label: "Permission", value: snapshot.permission },
    { label: "Service Worker", value: snapshot.serviceWorker },
  ]);
}

export function collectNotificationDiagnosticSection(
  env: NotificationDiagnosticEnvironment = defaultNotificationDiagnosticEnvironment,
): string {
  return formatNotificationDiagnosticSection(collectNotificationDiagnosticSnapshot(env));
}

const defaultNotificationDiagnosticEnvironment: NotificationDiagnosticEnvironment = {
  isWeb,
  isNative,
  hasDesktopBridge: () => typeof getDesktopHost()?.notification?.sendNotification === "function",
  getNotificationPermission: () => {
    const NotificationConstructor = (globalThis as { Notification?: { permission?: string } })
      .Notification;
    if (!NotificationConstructor || typeof NotificationConstructor.permission !== "string") {
      return null;
    }
    return NotificationConstructor.permission;
  },
  hasServiceWorker: () => {
    const serviceWorker = (globalThis as { navigator?: { serviceWorker?: unknown } }).navigator
      ?.serviceWorker;
    return serviceWorker != null;
  },
};
