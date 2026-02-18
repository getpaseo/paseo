import { Platform } from "react-native";
import { buildNotificationRoute } from "./notification-routing";
import { getTauri, type TauriNotificationApi } from "@/utils/tauri";

type OsNotificationPayload = {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
};

export type WebNotificationClickDetail = {
  data?: Record<string, unknown>;
};

type WebNotificationInstance = {
  onclick?: ((event: Event) => void) | null;
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
  close?: () => void;
};

export const WEB_NOTIFICATION_CLICK_EVENT = "paseo:web-notification-click";

let permissionRequest: Promise<boolean> | null = null;

function getTauriNotificationModule(): TauriNotificationApi | null {
  if (Platform.OS !== "web") {
    return null;
  }
  return getTauri()?.notification ?? null;
}

function getWebNotificationConstructor(): {
  permission: string;
  requestPermission?: () => Promise<string>;
  new (title: string, options?: { body?: string; data?: Record<string, unknown> }): unknown;
} | null {
  const NotificationConstructor = (globalThis as { Notification?: any }).Notification;
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
      : "denied"
  ).then((permission) => permission === "granted");
  const result = await permissionRequest;
  permissionRequest = null;
  return result;
}

export async function ensureOsNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== "web") {
    return false;
  }

  const tauriNotification = getTauriNotificationModule();
  if (tauriNotification) {
    return await ensureTauriNotificationPermission(tauriNotification);
  }

  return await ensureNotificationPermission();
}

async function ensureTauriNotificationPermission(
  notificationModule: TauriNotificationApi
): Promise<boolean> {
  if (typeof notificationModule.isPermissionGranted === "function") {
    try {
      const granted = await notificationModule.isPermissionGranted();
      if (granted) {
        console.log("[OSNotifications][Tauri] Permission already granted");
        return true;
      }
    } catch (error) {
      console.warn(
        "[OSNotifications][Tauri] Failed to check notification permission",
        error
      );
    }
  }

  if (typeof notificationModule.requestPermission !== "function") {
    console.warn(
      "[OSNotifications][Tauri] notification.requestPermission is unavailable"
    );
    return false;
  }

  try {
    const result = await notificationModule.requestPermission();
    console.log("[OSNotifications][Tauri] requestPermission result:", result);
    return result === "granted";
  } catch (error) {
    console.warn(
      "[OSNotifications][Tauri] Failed to request notification permission",
      error
    );
    return false;
  }
}

async function sendTauriNotification(
  payload: OsNotificationPayload,
  notificationModule: TauriNotificationApi
): Promise<boolean> {
  if (typeof notificationModule.sendNotification !== "function") {
    console.warn(
      "[OSNotifications][Tauri] notification.sendNotification is unavailable"
    );
    return false;
  }

  const granted = await ensureTauriNotificationPermission(notificationModule);
  if (!granted) {
    console.log("[OSNotifications][Tauri] Permission not granted");
    return false;
  }

  try {
    await notificationModule.sendNotification({
      title: payload.title,
      body: payload.body,
    });
    return true;
  } catch (error) {
    console.warn("[OSNotifications][Tauri] Failed to send notification", error);
    return false;
  }
}

function dispatchWebNotificationClick(detail: WebNotificationClickDetail): boolean {
  const dispatch = (globalThis as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
  const CustomEventConstructor = (globalThis as { CustomEvent?: typeof CustomEvent })
    .CustomEvent;

  if (typeof dispatch !== "function" || !CustomEventConstructor) {
    return false;
  }

  const event = new CustomEventConstructor<WebNotificationClickDetail>(
    WEB_NOTIFICATION_CLICK_EVENT,
    {
      detail,
      cancelable: true,
    }
  );
  return dispatch(event) === false;
}

function fallbackNavigateToNotificationTarget(
  data: Record<string, unknown> | undefined
): void {
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
  data: Record<string, unknown> | undefined
): void {
  const onClick = () => {
    const focus = (globalThis as { focus?: () => void }).focus;
    if (typeof focus === "function") {
      focus();
    }

    const handledByApp = dispatchWebNotificationClick({ data });
    if (!handledByApp) {
      fallbackNavigateToNotificationTarget(data);
    }

    if (typeof notification.close === "function") {
      notification.close();
    }
  };

  if (typeof notification.addEventListener === "function") {
    notification.addEventListener("click", onClick);
    return;
  }

  notification.onclick = onClick;
}

export async function sendOsNotification(
  payload: OsNotificationPayload
): Promise<boolean> {
  // Mobile/native notifications should be remote push only.
  if (Platform.OS !== "web") {
    return false;
  }

  const tauriNotification = getTauriNotificationModule();
  if (tauriNotification) {
    console.log("[OSNotifications] Using Tauri notification module");
    return await sendTauriNotification(payload, tauriNotification);
  }

  const NotificationConstructor = getWebNotificationConstructor();
  if (!NotificationConstructor) {
    console.log(
      "[OSNotifications][Web] Notification constructor unavailable",
      typeof window !== "undefined" && window.location
        ? window.location.origin
        : "unknown-origin"
    );
    return false;
  }
  const granted = await ensureOsNotificationPermission();
  if (!granted) {
    console.log(
      "[OSNotifications][Web] Permission not granted:",
      NotificationConstructor.permission
    );
    return false;
  }
  const notification = new NotificationConstructor(payload.title, {
    body: payload.body,
    data: payload.data,
  }) as WebNotificationInstance;
  attachWebClickHandler(notification, payload.data);
  return true;
}
