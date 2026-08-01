import { Platform } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";

export type InteractionUnlockAuthResult =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "unavailable" | "failed"; message?: string };

/**
 * Prompt for OS biometric / device credential before unlocking interaction lock.
 * Android-first: device PIN/pattern is allowed as fallback when biometrics are absent.
 * Non-Android platforms skip auth (caller still decides whether to unlock).
 */
export async function authenticateForInteractionUnlock(input: {
  promptMessage: string;
  cancelLabel?: string;
}): Promise<InteractionUnlockAuthResult> {
  if (Platform.OS !== "android") {
    return { ok: true };
  }

  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hasHardware && !isEnrolled) {
      // Still attempt authenticateAsync — some devices expose device credential only.
    }

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: input.promptMessage,
      cancelLabel: input.cancelLabel,
      disableDeviceFallback: false,
      biometricsSecurityLevel: "weak",
    });

    if (result.success) {
      return { ok: true };
    }

    if (result.error === "user_cancel" || result.error === "system_cancel") {
      return { ok: false, reason: "cancelled" };
    }
    if (
      result.error === "not_available" ||
      result.error === "not_enrolled" ||
      result.error === "passcode_not_set"
    ) {
      return {
        ok: false,
        reason: "unavailable",
        message: result.error,
      };
    }
    return { ok: false, reason: "failed", message: result.error };
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
