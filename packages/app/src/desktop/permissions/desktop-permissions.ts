import { type DesktopHostBridge, getDesktopHost } from "@/desktop/host";
import { isNative, isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

export type DesktopPermissionKind = "notifications" | "microphone";

export type DesktopPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "not-granted"
  | "unavailable"
  | "unknown";

export interface DesktopPermissionStatus {
  state: DesktopPermissionState;
  detail: string;
}

export interface DesktopPermissionSnapshot {
  checkedAt: number;
  notifications: DesktopPermissionStatus;
  microphone: DesktopPermissionStatus;
}

export interface NotificationConstructorLike {
  permission?: string;
  requestPermission?: () => Promise<string>;
}

interface MediaStreamTrackLike {
  stop?: () => void;
}

interface MediaStreamLike {
  getTracks?: () => MediaStreamTrackLike[];
}

export interface NavigatorLike {
  mediaDevices?: {
    getUserMedia?: (constraints: { audio: boolean }) => Promise<MediaStreamLike>;
  };
  permissions?: {
    query?: (descriptor: { name: string }) => Promise<{ state?: string }>;
  };
}

export interface DesktopPermissionEnvironment {
  isWeb: boolean;
  getDesktopHost: () => DesktopHostBridge | null;
  getNotification: () => NotificationConstructorLike | null;
  getNavigator: () => NavigatorLike | null;
}

export interface DesktopPermissions {
  shouldShowDesktopPermissionSection: () => boolean;
  getDesktopPermissionSnapshot: () => Promise<DesktopPermissionSnapshot>;
  requestDesktopPermission: (input: {
    kind: DesktopPermissionKind;
  }) => Promise<DesktopPermissionStatus>;
}

function status(input: DesktopPermissionStatus): DesktopPermissionStatus {
  return input;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function getErrorName(error: unknown): string | null {
  if (!isObject(error)) {
    return null;
  }
  const name = error.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function isPermissionsQueryRuntimeUnsupported(error: unknown): boolean {
  const message = getErrorMessage(error);
  if (
    message.includes("Can only call Permissions.query on instances of Permissions") ||
    message.includes("Illegal invocation")
  ) {
    return true;
  }
  return false;
}

function mapNotificationPermissionString(permission: string): DesktopPermissionStatus {
  if (permission === "granted") {
    return status({
      state: "granted",
      detail: i18n.t("desktop.permissions.notifications.allowed"),
    });
  }
  if (permission === "denied") {
    return status({
      state: "denied",
      detail: i18n.t("desktop.permissions.notifications.denied"),
    });
  }
  if (permission === "default") {
    return status({
      state: "prompt",
      detail: i18n.t("desktop.permissions.notifications.notGranted"),
    });
  }
  return status({
    state: "unknown",
    detail: i18n.t("desktop.permissions.notifications.unexpectedState", {
      state: permission,
    }),
  });
}

export function createDesktopPermissions(env: DesktopPermissionEnvironment): DesktopPermissions {
  function shouldShowDesktopPermissionSection(): boolean {
    return env.isWeb && env.getDesktopHost() !== null;
  }

  async function getNotificationPermissionStatus(): Promise<DesktopPermissionStatus> {
    if (!env.isWeb) {
      return status({
        state: "unavailable",
        detail: i18n.t("desktop.permissions.notifications.webOnly"),
      });
    }

    const desktopHost = env.getDesktopHost();
    if (desktopHost && typeof desktopHost.notification?.isSupported === "function") {
      try {
        const supported = await desktopHost.notification.isSupported();
        return status({
          state: supported ? "granted" : "unavailable",
          detail: supported
            ? i18n.t("desktop.permissions.notifications.supported")
            : i18n.t("desktop.permissions.notifications.unsupported"),
        });
      } catch {
        // Fall through to web API check
      }
    }

    const NotificationConstructor = env.getNotification();
    if (NotificationConstructor && typeof NotificationConstructor.permission === "string") {
      return mapNotificationPermissionString(NotificationConstructor.permission);
    }

    return status({
      state: "unavailable",
      detail: i18n.t("desktop.permissions.notifications.apiUnavailable"),
    });
  }

  async function getMicrophonePermissionStatus(): Promise<DesktopPermissionStatus> {
    if (!env.isWeb) {
      return status({
        state: "unavailable",
        detail: i18n.t("desktop.permissions.microphone.webOnly"),
      });
    }

    const webNavigator = env.getNavigator();
    if (!webNavigator) {
      return status({
        state: "unavailable",
        detail: i18n.t("desktop.permissions.microphone.navigatorUnavailable"),
      });
    }

    const permissionsApi = webNavigator.permissions;
    if (permissionsApi && typeof permissionsApi.query === "function") {
      try {
        const result = await permissionsApi.query({ name: "microphone" });
        if (result?.state === "granted") {
          return status({
            state: "granted",
            detail: i18n.t("desktop.permissions.microphone.granted"),
          });
        }
        if (result?.state === "denied") {
          return status({
            state: "denied",
            detail: i18n.t("desktop.permissions.microphone.denied"),
          });
        }
        if (result?.state === "prompt") {
          return status({
            state: "prompt",
            detail: i18n.t("desktop.permissions.microphone.notGranted"),
          });
        }
        return status({
          state: "unknown",
          detail: i18n.t("desktop.permissions.microphone.unexpectedState", {
            state: result?.state ?? "unknown",
          }),
        });
      } catch (error) {
        if (isPermissionsQueryRuntimeUnsupported(error)) {
          return status({
            state: "unknown",
            detail: i18n.t("desktop.permissions.microphone.statusApiUnavailable"),
          });
        }
        return status({
          state: "unknown",
          detail: i18n.t("desktop.permissions.microphone.queryFailed", {
            message: getErrorMessage(error),
          }),
        });
      }
    }

    if (typeof webNavigator.mediaDevices?.getUserMedia !== "function") {
      return status({
        state: "unavailable",
        detail: i18n.t("desktop.permissions.microphone.captureUnavailable"),
      });
    }

    return status({
      state: "unknown",
      detail: i18n.t("desktop.permissions.microphone.permissionApiUnavailable"),
    });
  }

  async function requestNotificationPermissionStatus(): Promise<DesktopPermissionStatus> {
    if (!env.isWeb) {
      return status({
        state: "unavailable",
        detail: i18n.t("desktop.permissions.notifications.requestsWebOnly"),
      });
    }

    const NotificationConstructor = env.getNotification();
    if (
      NotificationConstructor &&
      typeof NotificationConstructor.requestPermission === "function"
    ) {
      try {
        const permission = await NotificationConstructor.requestPermission();
        return mapNotificationPermissionString(permission);
      } catch (error) {
        return status({
          state: "unknown",
          detail: i18n.t("desktop.permissions.notifications.requestFailed", {
            message: getErrorMessage(error),
          }),
        });
      }
    }

    return status({
      state: "unavailable",
      detail: i18n.t("desktop.permissions.notifications.requestUnavailable"),
    });
  }

  async function requestMicrophonePermissionStatus(): Promise<DesktopPermissionStatus> {
    if (!env.isWeb) {
      return status({
        state: "unavailable",
        detail: i18n.t("desktop.permissions.microphone.requestsWebOnly"),
      });
    }

    const webNavigator = env.getNavigator();
    if (!webNavigator || typeof webNavigator.mediaDevices?.getUserMedia !== "function") {
      return status({
        state: "unavailable",
        detail: i18n.t("desktop.permissions.microphone.captureApiUnavailable"),
      });
    }

    try {
      const stream = await webNavigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = stream && typeof stream.getTracks === "function" ? stream.getTracks() : [];
      tracks.forEach((track) => {
        if (typeof track.stop === "function") {
          track.stop();
        }
      });
      return await getMicrophonePermissionStatus();
    } catch (error) {
      const errorName = getErrorName(error);
      if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
        return status({
          state: "denied",
          detail: i18n.t("desktop.permissions.microphone.requestDenied"),
        });
      }
      if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
        return status({
          state: "unavailable",
          detail: i18n.t("desktop.permissions.microphone.noDevice"),
        });
      }
      return status({
        state: "unknown",
        detail: i18n.t("desktop.permissions.microphone.requestFailed", {
          message: getErrorMessage(error),
        }),
      });
    }
  }

  async function requestDesktopPermission(input: {
    kind: DesktopPermissionKind;
  }): Promise<DesktopPermissionStatus> {
    if (input.kind === "notifications") {
      return await requestNotificationPermissionStatus();
    }
    return await requestMicrophonePermissionStatus();
  }

  async function getDesktopPermissionSnapshot(): Promise<DesktopPermissionSnapshot> {
    const [notifications, microphone] = await Promise.all([
      getNotificationPermissionStatus(),
      getMicrophonePermissionStatus(),
    ]);

    return {
      checkedAt: Date.now(),
      notifications,
      microphone,
    };
  }

  return {
    shouldShowDesktopPermissionSection,
    getDesktopPermissionSnapshot,
    requestDesktopPermission,
  };
}

function getRealNotification(): NotificationConstructorLike | null {
  if (isNative) {
    return null;
  }
  const NotificationConstructor = (globalThis as { Notification?: unknown }).Notification;
  if (
    NotificationConstructor == null ||
    (typeof NotificationConstructor !== "function" && typeof NotificationConstructor !== "object")
  ) {
    return null;
  }
  return NotificationConstructor as NotificationConstructorLike;
}

function getRealNavigator(): NavigatorLike | null {
  if (isNative) {
    return null;
  }
  const webNavigator = (globalThis as { navigator?: unknown }).navigator;
  if (!isObject(webNavigator)) {
    return null;
  }
  return webNavigator as NavigatorLike;
}

const realDesktopPermissions = createDesktopPermissions({
  isWeb,
  getDesktopHost,
  getNotification: getRealNotification,
  getNavigator: getRealNavigator,
});

export const shouldShowDesktopPermissionSection =
  realDesktopPermissions.shouldShowDesktopPermissionSection;
export const getDesktopPermissionSnapshot = realDesktopPermissions.getDesktopPermissionSnapshot;
export const requestDesktopPermission = realDesktopPermissions.requestDesktopPermission;
