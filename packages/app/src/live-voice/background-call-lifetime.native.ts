import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

/**
 * What the notification's buttons mean. The names are the native side's, kept
 * short because they cross the bridge as data rather than as a typed enum.
 */
export type LiveVoiceBackgroundCallAction = "toggleMute" | "end";

interface PaseoBackgroundCallModule {
  begin(): Promise<void>;
  update(isMuted: boolean): Promise<void>;
  end(): Promise<void>;
  addListener(
    eventName: "onBackgroundCallAction",
    handler: (event: { action: string }) => void,
  ): EventSubscription;
}

function getOptionalBackgroundCallModule(): PaseoBackgroundCallModule | null {
  return requireOptionalNativeModule<PaseoBackgroundCallModule>("PaseoBackgroundCall");
}

function getBackgroundCallModule(): PaseoBackgroundCallModule {
  const backgroundCallModule = getOptionalBackgroundCallModule();
  if (!backgroundCallModule) {
    throw new Error("Live Voice background mode is unavailable in this app binary");
  }
  return backgroundCallModule;
}

export function isLiveVoiceBackgroundCallSupported(): boolean {
  return getOptionalBackgroundCallModule() !== null;
}

export async function beginLiveVoiceBackgroundCall(): Promise<void> {
  await getBackgroundCallModule().begin();
}

/**
 * Push current call state into the ongoing notification. iOS has no notification
 * to update, so its module omits `update` entirely and this resolves silently.
 */
export async function updateLiveVoiceBackgroundCall(params: { isMuted: boolean }): Promise<void> {
  const backgroundCallModule = getOptionalBackgroundCallModule();
  await backgroundCallModule?.update?.(params.isMuted);
}

export async function endLiveVoiceBackgroundCall(): Promise<void> {
  await getBackgroundCallModule().end();
}

/**
 * Listen for the notification's Mute and End call buttons. Returns a no-op
 * unsubscribe on binaries without the module so callers need no gate of their own.
 */
export function subscribeLiveVoiceBackgroundCallActions(
  listener: (action: LiveVoiceBackgroundCallAction) => void,
): () => void {
  const backgroundCallModule = getOptionalBackgroundCallModule();
  if (!backgroundCallModule?.addListener) {
    return () => undefined;
  }

  const subscription = backgroundCallModule.addListener("onBackgroundCallAction", (event) => {
    if (event.action === "toggleMute" || event.action === "end") {
      listener(event.action);
    }
  });
  return () => subscription.remove();
}
