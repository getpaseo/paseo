import { Platform } from "react-native";

type OsNotificationPayload = {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
};

let permissionRequest: Promise<boolean> | null = null;

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

export async function sendOsNotification(
  payload: OsNotificationPayload
): Promise<boolean> {
  // Mobile/native notifications should be remote push only.
  if (Platform.OS !== "web") {
    return false;
  }

  const NotificationConstructor = getWebNotificationConstructor();
  if (!NotificationConstructor) {
    return false;
  }
  const granted = await ensureNotificationPermission();
  if (!granted) {
    return false;
  }
  new NotificationConstructor(payload.title, {
    body: payload.body,
    data: payload.data,
  });
  return true;
}
