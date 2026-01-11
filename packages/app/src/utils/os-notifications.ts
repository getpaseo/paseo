import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

type OsNotificationPayload = {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
};

let isNativeConfigured = false;
let permissionState: "unknown" | "granted" | "denied" = "unknown";
let permissionRequest: Promise<boolean> | null = null;

function getWebNotificationConstructor(): {
  permission: string;
  requestPermission?: () => Promise<string>;
  new (title: string, options?: { body?: string; data?: Record<string, unknown> }): unknown;
} | null {
  const NotificationConstructor = (globalThis as { Notification?: any }).Notification;
  return NotificationConstructor ?? null;
}

async function configureNativeNotifications(): Promise<void> {
  if (isNativeConfigured || Platform.OS === "web") {
    return;
  }
  isNativeConfigured = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS === "web") {
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

  if (permissionState === "granted") {
    return true;
  }
  if (permissionState === "denied") {
    return false;
  }
  if (permissionRequest) {
    return permissionRequest;
  }

  permissionRequest = (async () => {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === "granted") {
      permissionState = "granted";
      return true;
    }
    if (!existing.canAskAgain) {
      permissionState = "denied";
      return false;
    }
    const requested = await Notifications.requestPermissionsAsync();
    permissionState = requested.status === "granted" ? "granted" : "denied";
    return permissionState === "granted";
  })();

  const result = await permissionRequest;
  permissionRequest = null;
  return result;
}

export async function sendOsNotification(
  payload: OsNotificationPayload
): Promise<boolean> {
  if (Platform.OS === "web") {
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

  await configureNativeNotifications();
  const granted = await ensureNotificationPermission();
  if (!granted) {
    return false;
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: payload.title,
      body: payload.body,
      data: payload.data,
    },
    trigger: null,
  });

  return true;
}
