import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type { UnifiedPushDistributor, UnifiedPushEvent } from "./unified-push-shared";

interface PaseoUnifiedPushModule {
  addListener(eventName: "message", handler: (event: UnifiedPushEvent) => void): EventSubscription;
  getDistributors(): UnifiedPushDistributor[];
  getSavedDistributor(): string | null;
  registerDevice(vapidPublicKey: string, instance?: string): Promise<void>;
  saveDistributor(distributor: string | null): void;
  unregisterDevice(instance?: string): void;
}

export const PaseoUnifiedPush = requireNativeModule<PaseoUnifiedPushModule>("PaseoUnifiedPush");
