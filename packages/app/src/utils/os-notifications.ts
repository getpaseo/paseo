import { Asset } from "expo-asset";
import { getDesktopHost } from "@/desktop/host";
import { buildNotificationRoute, resolveNotificationTarget } from "./notification-routing";
import { isNative } from "@/constants/platform";

interface OsNotificationPayload {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface WebNotificationClickDetail {
  data?: Record<string, unknown>;
}

interface WebNotificationInstance {
  addEventListener: (type: "click", listener: (event: Event) => void) => void;
}

export const WEB_NOTIFICATION_CLICK_EVENT = "paseo:web-notification-click";

let permissionRequest: Promise<boolean> | null = null;
let notificationIconUrl: string | null | undefined;

function getDesktopNotificationSender():
  | ((payload: {
      title: string;
      body?: string;
      data?: Record<string, unknown>;
    }) => Promise<boolean>)
  | null {
  const sendNotification = getDesktopHost()?.notification?.sendNotification;
  return typeof sendNotification === "function"
    ? (sendNotification as (payload: {
        title: string;
        body?: string;
        data?: Record<string, unknown>;
      }) => Promise<boolean>)
    : null;
}

function getWebNotificationConstructor(): {
  permission: string;
  requestPermission?: () => Promise<string>;
  new (
    title: string,
    options?: {
      body?: string;
      data?: Record<string, unknown>;
      icon?: string;
    },
  ): unknown;
} | null {
  const NotificationConstructor = (
    globalThis as {
      Notification?: {
        permission: string;
        requestPermission?: () => Promise<string>;
        new (
          title: string,
          options?: { body?: string; data?: Record<string, unknown>; icon?: string },
        ): unknown;
      };
    }
  ).Notification;
  return NotificationConstructor ?? null;
}

async function ensureNotificationPermission(): Promise<boolean> {
  const NotificationConstructor = getWebNotificationConstructor();
  if (!NotificationConstructor) {
    return false;
  }
  if (NotificationConstructor.permission === "granted") {
    return true;
  }
  if (NotificationConstructor.permission === "denied") {
    return false;
  }
  if (permissionRequest) {
    return permissionRequest;
  }
  permissionRequest = Promise.resolve(
    NotificationConstructor.requestPermission
      ? NotificationConstructor.requestPermission()
      : "denied",
  ).then((permission) => permission === "granted");
  const result = await permissionRequest;
  permissionRequest = null;
  return result;
}

export async function ensureOsNotificationPermission(): Promise<boolean> {
  if (isNative) {
    return false;
  }
  return await ensureNotificationPermission();
}

function hasNotificationClickTarget(data: Record<string, unknown> | undefined): boolean {
  const target = resolveNotificationTarget(data);
  return target.serverId !== null || target.agentId !== null || target.workspaceId !== null;
}

function getWebNotificationIconUrl(): string | undefined {
  if (notificationIconUrl !== undefined) {
    return notificationIconUrl ?? undefined;
  }

  try {
    const asset = Asset.fromModule(require("../../assets/images/notification-icon.png"));
    notificationIconUrl = asset.uri ?? null;
  } catch {
    notificationIconUrl = null;
  }

  return notificationIconUrl ?? undefined;
}

function dispatchWebNotificationClick(detail: WebNotificationClickDetail): boolean {
  const dispatch = (globalThis as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
  const CustomEventConstructor = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;

  if (typeof dispatch !== "function" || !CustomEventConstructor) {
    return false;
  }

  const event = new CustomEventConstructor<WebNotificationClickDetail>(
    WEB_NOTIFICATION_CLICK_EVENT,
    {
      detail,
      cancelable: true,
    },
  );
  return !dispatch(event);
}

function fallbackNavigateToNotificationTarget(data: Record<string, unknown> | undefined): void {
  const route = buildNotificationRoute(data);
  const location = (globalThis as { location?: { assign?: (url: string) => void; href?: string } })
    .location;
  if (!location) {
    return;
  }
  if (typeof location.assign === "function") {
    location.assign(route);
    return;
  }
  if (typeof location.href === "string") {
    location.href = route;
  }
}

function attachWebClickHandler(
  notification: WebNotificationInstance,
  data: Record<string, unknown> | undefined,
): void {
  notification.addEventListener("click", () => {
    const handledByApp = dispatchWebNotificationClick({ data });
    if (!handledByApp) {
      fallbackNavigateToNotificationTarget(data);
    }
  });
}

export async function sendOsNotification(payload: OsNotificationPayload): Promise<boolean> {
  // Mobile/native notifications should be remote push only.
  if (isNative) {
    return false;
  }

  const desktopNotificationSender = getDesktopNotificationSender();
  if (desktopNotificationSender) {
    return await desktopNotificationSender(payload);
  }

  const NotificationConstructor = getWebNotificationConstructor();
  if (NotificationConstructor) {
    const granted = await ensureNotificationPermission();
    if (granted) {
      const notification = new NotificationConstructor(payload.title, {
        body: payload.body,
        data: payload.data,
        icon: getWebNotificationIconUrl(),
      }) as WebNotificationInstance;
      if (hasNotificationClickTarget(payload.data)) {
        attachWebClickHandler(notification, payload.data);
      }
      return true;
    }
  }

  return false;
}
