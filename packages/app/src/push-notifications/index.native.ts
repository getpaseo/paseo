import Constants from "expo-constants";
import { revokeSubscription, startSubscription } from "./internal/subscriptions";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

export function startPushNotifications(input: StartPushNotificationsInput): () => void {
  if (!isBackgroundPushConfigured()) return () => {};
  return startSubscription(input);
}

export function revokePushNotifications(input: RevokePushNotificationsInput): Promise<void> {
  return revokeSubscription(input).catch((error) => {
    console.warn("[PushNotifications] Failed to remove local push subscription", error);
  });
}

export function isBackgroundPushConfigured(): boolean {
  return (
    Constants.expoConfig?.extra?.enhancedBranding !== true ||
    Constants.expoConfig?.extra?.enhancedPushConfigured === true
  );
}
