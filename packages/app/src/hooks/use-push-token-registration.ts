import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import type { DaemonClientV2 } from "@server/client/daemon-client-v2";

const STORAGE_PREFIX = "@paseo:expo-push-token:";

function getExpoProjectId(): string | null {
  const fromEas = (Constants as any)?.easConfig?.projectId;
  if (typeof fromEas === "string" && fromEas.trim()) return fromEas.trim();

  const fromExtra = (Constants as any)?.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExtra === "string" && fromExtra.trim()) return fromExtra.trim();

  return null;
}

async function ensurePushPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === "granted") return true;
  if (!existing.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === "granted";
}

export function usePushTokenRegistration(params: {
  client: DaemonClientV2;
  serverId: string;
}): void {
  const { client, serverId } = params;
  const tokenRef = useRef<string | null>(null);
  const lastSentTokenRef = useRef<string | null>(null);

  const registerIfPossible = useCallback(async () => {
    if (Platform.OS === "web") return;
    if (!client.isConnected) return;
    const token = tokenRef.current;
    if (!token) return;
    if (lastSentTokenRef.current === token) return;
    lastSentTokenRef.current = token;
    client.registerPushToken(token);
  }, [client]);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const storageKey = `${STORAGE_PREFIX}${serverId}`;
    let cancelled = false;

    const run = async () => {
      const cached = await AsyncStorage.getItem(storageKey);
      if (cancelled) return;
      if (cached && typeof cached === "string") {
        tokenRef.current = cached;
      }

      const granted = await ensurePushPermission();
      if (!granted || cancelled) return;

      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("default", {
          name: "default",
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      }

      const projectId = getExpoProjectId();
      if (!projectId) {
        console.warn("[PushToken] Missing EAS projectId; cannot fetch Expo push token");
        return;
      }

      const result = await Notifications.getExpoPushTokenAsync({ projectId });
      if (cancelled) return;

      const token = result.data;
      if (typeof token !== "string" || !token.trim()) return;

      tokenRef.current = token;
      await AsyncStorage.setItem(storageKey, token);
      await registerIfPossible();
    };

    void run().catch((error) => {
      console.warn("[PushToken] Failed to register push token", error);
    });

    return () => {
      cancelled = true;
    };
  }, [registerIfPossible, serverId]);

  useEffect(() => {
    const unsubscribe = client.subscribeConnectionStatus((state) => {
      if (state.status === "connected") {
        void registerIfPossible();
      } else {
        // Re-register on the next successful connect.
        lastSentTokenRef.current = null;
      }
    });
    if (client.isConnected) {
      void registerIfPossible();
    }
    return unsubscribe;
  }, [client, registerIfPossible]);
}
