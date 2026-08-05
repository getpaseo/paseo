import { Platform } from "react-native";
import { useInteractionLockStore } from "@/stores/interaction-lock-store";
import { authenticateForInteractionUnlock } from "./auth";

export type UnlockInteractionResult =
  | { status: "unlocked" }
  | { status: "cancelled" }
  | { status: "failed"; message?: string };

/** Enter whole-app view-only lock. No confirmation / auth required. */
export function lockInteractionScreen(): void {
  useInteractionLockStore.getState().setLocked(true);
}

/**
 * Exit interaction lock. On Android, requires biometric or device credential.
 * Other platforms unlock immediately (Android is the product focus).
 */
export async function unlockInteractionScreen(input: {
  promptMessage: string;
  cancelLabel?: string;
}): Promise<UnlockInteractionResult> {
  if (!useInteractionLockStore.getState().locked) {
    return { status: "unlocked" };
  }

  if (Platform.OS === "android") {
    const auth = await authenticateForInteractionUnlock({
      promptMessage: input.promptMessage,
      cancelLabel: input.cancelLabel,
    });
    if (!auth.ok) {
      if (auth.reason === "cancelled") {
        return { status: "cancelled" };
      }
      return { status: "failed", message: auth.message };
    }
  }

  useInteractionLockStore.getState().setLocked(false);
  return { status: "unlocked" };
}

/** True when navigation / control surfaces may run. */
export function isInteractionNavigationAllowed(): boolean {
  return !useInteractionLockStore.getState().locked;
}
