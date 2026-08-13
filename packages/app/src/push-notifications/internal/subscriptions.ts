import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./types";

const STORAGE_PREFIX = "@paseo:expo-push-token:";

function storageKey(serverId: string): string {
  return `${STORAGE_PREFIX}${serverId}`;
}

function getExpoProjectId(): string | null {
  const constants = Constants as unknown as {
    easConfig?: { projectId?: unknown };
    expoConfig?: { extra?: { eas?: { projectId?: unknown } } };
  };
  const fromEas = constants.easConfig?.projectId;
  if (typeof fromEas === "string" && fromEas.trim()) return fromEas.trim();
  const fromExtra = constants.expoConfig?.extra?.eas?.projectId;
  return typeof fromExtra === "string" && fromExtra.trim() ? fromExtra.trim() : null;
}

async function ensurePushPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === Notifications.PermissionStatus.GRANTED) return true;
  if (!existing.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === Notifications.PermissionStatus.GRANTED;
}

async function resolveToken(serverId: string): Promise<string | null> {
  const key = storageKey(serverId);
  const cached = await AsyncStorage.getItem(key);
  if (!(await ensurePushPermission())) {
    await AsyncStorage.removeItem(key);
    return null;
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = getExpoProjectId();
  if (!projectId) {
    console.warn("[PushNotifications] Missing EAS projectId; cannot fetch Expo push token");
    return cached;
  }

  const result = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = result.data.trim();
  if (!token) return cached;
  await AsyncStorage.setItem(key, token);
  return token;
}

export function startSubscription(input: StartPushNotificationsInput): () => void {
  let stopped = false;
  let token: string | null = null;
  const register = () => {
    if (!stopped && token && input.client.isConnected) {
      input.client.registerPushToken(token);
    }
  };

  void resolveToken(input.serverId)
    .then((resolved) => {
      if (stopped) return undefined;
      token = resolved;
      register();
      return undefined;
    })
    .catch((error) => console.warn("[PushNotifications] Failed to register push token", error));

  const unsubscribe = input.client.subscribeConnectionStatus((state) => {
    if (state.status === "connected") register();
  });

  return () => {
    stopped = true;
    unsubscribe();
  };
}

export async function revokeSubscription(input: RevokePushNotificationsInput): Promise<void> {
  const key = storageKey(input.serverId);
  const token = await AsyncStorage.getItem(key);
  if (
    token &&
    input.client?.isConnected &&
    input.client.getLastServerInfoMessage()?.features?.pushTokenRevocation === true
  ) {
    try {
      await input.client.unregisterPushToken(token);
    } catch (error) {
      console.warn("[PushNotifications] Failed to revoke push token", error);
    }
  }
  await AsyncStorage.removeItem(key);
}
