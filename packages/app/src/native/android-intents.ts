import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

interface PaseoAndroidIntentsModule {
  consumeLaunchIntent(): unknown;
  setResumeShortcut(id: string, label: string, uri: string): void;
  clearDynamicShortcuts(): void;
  addListener(eventName: "onIntent", listener: (payload: unknown) => void): EventSubscription;
}

const nativeModule = requireOptionalNativeModule<PaseoAndroidIntentsModule>("PaseoAndroidIntents");

/**
 * Android-only bridge for intents Expo's linking layer cannot express: share
 * sheet payloads, PROCESS_TEXT selections, and launcher shortcuts. Resolves to
 * a no-op everywhere else.
 */
export const androidIntents = {
  isAvailable: nativeModule !== null,
  consumeLaunchIntent(): unknown {
    return nativeModule?.consumeLaunchIntent() ?? null;
  },
  addIntentListener(listener: (payload: unknown) => void): EventSubscription | null {
    return nativeModule?.addListener("onIntent", listener) ?? null;
  },
  setResumeShortcut(input: { id: string; label: string; uri: string }): void {
    nativeModule?.setResumeShortcut(input.id, input.label, input.uri);
  },
  clearDynamicShortcuts(): void {
    nativeModule?.clearDynamicShortcuts();
  },
};
