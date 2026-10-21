import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

interface PaseoAndroidIntentsModule {
  consumeLaunchIntent(): unknown;
  setResumeShortcut(id: string, label: string, uri: string): void;
  clearDynamicShortcuts(): void;
  publishAssistantCatalog(json: string): void;
  resolveAssistantQuery(requestId: string, json: string): void;
  addListener(
    eventName: "onIntent" | "onAssistantQuery",
    listener: (payload: unknown) => void,
  ): EventSubscription;
}

const nativeModule = requireOptionalNativeModule<PaseoAndroidIntentsModule>("PaseoAndroidIntents");

/**
 * Android-only bridge for intents Expo's linking layer cannot express: share
 * sheet payloads, PROCESS_TEXT selections, launcher shortcuts, and the catalog
 * the assistant content provider serves. Resolves to a no-op everywhere else.
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
  publishAssistantCatalog(json: string): void {
    nativeModule?.publishAssistantCatalog(json);
  },
  addAssistantQueryListener(listener: (payload: unknown) => void): EventSubscription | null {
    return nativeModule?.addListener("onAssistantQuery", listener) ?? null;
  },
  resolveAssistantQuery(requestId: string, json: string): void {
    nativeModule?.resolveAssistantQuery(requestId, json);
  },
};
