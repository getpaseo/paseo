import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

interface PaseoAndroidIntentsModule {
  consumeLaunchIntent(): unknown;
  addListener(eventName: "onIntent", listener: (payload: unknown) => void): EventSubscription;
}

const nativeModule = requireOptionalNativeModule<PaseoAndroidIntentsModule>("PaseoAndroidIntents");

/**
 * Android-only bridge for intents Expo's linking layer cannot express: share
 * sheet payloads and PROCESS_TEXT selections. Resolves to a no-op everywhere
 * else.
 */
export const androidIntents = {
  isAvailable: nativeModule !== null,
  consumeLaunchIntent(): unknown {
    return nativeModule?.consumeLaunchIntent() ?? null;
  },
  addIntentListener(listener: (payload: unknown) => void): EventSubscription | null {
    return nativeModule?.addListener("onIntent", listener) ?? null;
  },
};
