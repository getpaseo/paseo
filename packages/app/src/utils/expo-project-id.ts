import Constants from "expo-constants";

/**
 * Resolve the Expo/EAS project id baked into the native app config.
 * Required for Expo push token registration on mobile.
 */
export function getExpoProjectId(): string | null {
  const constants = Constants as unknown as {
    easConfig?: { projectId?: unknown };
    expoConfig?: { extra?: { eas?: { projectId?: unknown } } };
  };
  const fromEas = constants?.easConfig?.projectId;
  if (typeof fromEas === "string" && fromEas.trim()) {
    return fromEas.trim();
  }

  const fromExtra = constants?.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExtra === "string" && fromExtra.trim()) {
    return fromExtra.trim();
  }

  return null;
}

export function redactExpoPushToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 18) {
    return trimmed;
  }
  return `${trimmed.slice(0, 18)}…${trimmed.slice(-6)}`;
}
