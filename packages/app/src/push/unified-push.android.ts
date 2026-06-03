import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PermissionsAndroid } from "react-native";
import {
  type UnifiedPushEvent,
  handleUnifiedPushEvent,
  selectUnifiedPushDistributor,
} from "./unified-push-shared";
import { PaseoUnifiedPush } from "./paseo-unified-push-module.android";

const ENDPOINT_STORAGE_PREFIX = "@paseo:web-push-endpoint:";

async function ensureUnifiedPushPermission(): Promise<boolean> {
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (await PermissionsAndroid.check(permission)) return true;
  return (await PermissionsAndroid.request(permission)) === PermissionsAndroid.RESULTS.GRANTED;
}

export async function registerUnifiedPush(params: {
  client: DaemonClient;
  serverId: string;
  vapidPublicKey: string;
}): Promise<void> {
  const granted = await ensureUnifiedPushPermission();
  if (!granted) return;

  const distributors = PaseoUnifiedPush.getDistributors();
  const saved = PaseoUnifiedPush.getSavedDistributor();
  const selected = selectUnifiedPushDistributor(distributors, saved);

  if (!selected) {
    console.warn("[UnifiedPush] No distributor available");
    return;
  }

  PaseoUnifiedPush.saveDistributor(selected.id);
  await PaseoUnifiedPush.registerDevice(params.vapidPublicKey, params.serverId);
}

export function subscribeUnifiedPush(params: {
  client: DaemonClient;
  serverId: string;
}): () => void {
  const endpointStorageKey = `${ENDPOINT_STORAGE_PREFIX}${params.serverId}`;
  const listenerSubscription = PaseoUnifiedPush.addListener(
    "message",
    (event: UnifiedPushEvent) => {
      handleUnifiedPushEvent(event, {
        getStoredEndpoint: () => AsyncStorage.getItem(endpointStorageKey),
        removeStoredEndpoint: () => AsyncStorage.removeItem(endpointStorageKey),
        registerSubscription: (subscription) => {
          void params.client.registerPushSubscription({ subscription });
        },
        setStoredEndpoint: (endpoint) => AsyncStorage.setItem(endpointStorageKey, endpoint),
        showNotification: () => {
          // The Android PushService displays notifications so background delivery works.
        },
        unregisterSubscription: (endpoint) => {
          void params.client.unregisterPushSubscription({ endpoint });
        },
        warn: (message, error) => console.warn(message, error),
      });
    },
  );
  return () => listenerSubscription.remove();
}
