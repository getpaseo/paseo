import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export const WEB_NOTIFICATION_CLICK_EVENT = "paseo:web-notification-click";
export interface WebNotificationClickDetail {
  data?: Record<string, unknown>;
}
interface OsNotificationPayload {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}
let pendingPermission: Promise<boolean> | null = null;
async function requestPermission(): Promise<boolean> {
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("default", {
      name: "Paseo task notifications",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}
export async function ensureOsNotificationPermission(): Promise<boolean> {
  pendingPermission ??= requestPermission();
  try {
    return await pendingPermission;
  } finally {
    pendingPermission = null;
  }
}
export async function sendOsNotification(payload: OsNotificationPayload): Promise<boolean> {
  try {
    if (!(await ensureOsNotificationPermission())) return false;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: payload.title,
        body: payload.body,
        data: { ...payload.data, paseoLocalNotification: true },
      },
      trigger: null,
    });
    return true;
  } catch (error) {
    console.warn("[Notifications] Could not show task notification", error);
    return false;
  }
}
