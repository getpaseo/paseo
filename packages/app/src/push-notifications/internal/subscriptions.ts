import { parseServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  type NotificationPreferences,
} from "@getpaseo/protocol/notification-preferences";
import type { QueryClient } from "@tanstack/react-query";
import { queryClient as appQueryClient } from "@/data/query-client";
import {
  APP_SETTINGS_QUERY_KEY,
  loadAppSettingsFromStorage as loadAppSettingsFromStoragePure,
  type AppSettings,
  type SettingsDeps,
} from "@/hooks/use-settings/storage";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./types";

async function defaultResolveToken(serverId: string): Promise<string | null> {
  const { resolveExpoPushToken } = await import("./expo-token");
  return resolveExpoPushToken(serverId);
}

async function loadInitialAppSettings(settingsDeps?: SettingsDeps): Promise<AppSettings> {
  if (settingsDeps) {
    return loadAppSettingsFromStoragePure(settingsDeps);
  }
  const { loadAppSettingsFromStorage } = await import("@/hooks/use-settings");
  return loadAppSettingsFromStorage();
}

function readCachedPreferences(queryClient: QueryClient): NotificationPreferences | null {
  const cached = queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY);
  if (!cached) {
    return null;
  }
  return normalizeNotificationPreferences(cached.notifications);
}

export function startSubscription(input: StartPushNotificationsInput): () => void {
  let stopped = false;
  let token: string | null = null;
  let lastRegisteredSignature: string | null = null;
  const queryClient = input.queryClient ?? appQueryClient;
  const resolveToken = input.resolveToken ?? defaultResolveToken;

  const initialCached = readCachedPreferences(queryClient);
  let preferences: NotificationPreferences = initialCached ?? DEFAULT_NOTIFICATION_PREFERENCES;
  let preferencesReady = initialCached !== null;

  const register = (force = false) => {
    if (stopped || !token || !preferencesReady || !input.client.isConnected) {
      return;
    }
    // COMPAT(pushNotificationPreferences): added in v0.18.0, remove gate after 2027-06-01.
    const supportsPreferences =
      input.client.getLastServerInfoMessage()?.features?.pushNotificationPreferences === true;
    const signature = supportsPreferences
      ? `${token}:${JSON.stringify(preferences)}`
      : `${token}:legacy`;
    if (!force && signature === lastRegisteredSignature) {
      return;
    }
    lastRegisteredSignature = signature;
    if (supportsPreferences) {
      input.client.registerPushToken(token, preferences);
    } else {
      input.client.registerPushToken(token);
    }
  };

  if (!preferencesReady) {
    void loadInitialAppSettings(input.settingsDeps)
      .then((loaded) => {
        if (stopped) return undefined;
        const latestCached = readCachedPreferences(queryClient);
        preferences = latestCached ?? normalizeNotificationPreferences(loaded.notifications);
        preferencesReady = true;
        register();
        return undefined;
      })
      .catch(() => {
        if (stopped) return undefined;
        preferencesReady = true;
        register();
        return undefined;
      });
  }

  void resolveToken(input.serverId)
    .then((resolved) => {
      if (stopped) return undefined;
      token = resolved;
      register();
      return undefined;
    })
    .catch((error) => console.warn("[PushNotifications] Failed to register push token", error));

  const unsubscribeConnection = input.client.subscribeConnectionStatus((state) => {
    if (state.status === "connected") {
      lastRegisteredSignature = null;
      register(true);
    } else {
      lastRegisteredSignature = null;
    }
  });

  const unsubscribeStatus =
    input.client.on?.("status", (message) => {
      if (message.type === "status" && parseServerInfoStatusPayload(message.payload)) {
        register();
      }
    }) ?? (() => undefined);

  const unsubscribeQueryCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== APP_SETTINGS_QUERY_KEY[0]) {
      return;
    }
    const nextPreferences = readCachedPreferences(queryClient);
    if (!nextPreferences) {
      return;
    }
    preferences = nextPreferences;
    preferencesReady = true;
    register();
  });

  return () => {
    stopped = true;
    unsubscribeConnection();
    unsubscribeStatus();
    unsubscribeQueryCache();
  };
}

export async function revokeSubscription(input: RevokePushNotificationsInput): Promise<void> {
  const { readCachedExpoPushToken, removeCachedExpoPushToken } = await import("./expo-token");
  const token = await readCachedExpoPushToken(input.serverId);
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
  await removeCachedExpoPushToken(input.serverId);
}
