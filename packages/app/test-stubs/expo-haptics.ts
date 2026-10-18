// Test stub for expo-haptics. Haptics are native-only and never fire under test; the package
// pulls expo-modules-core, whose native-module registry cannot bundle in the browser build.
export const ImpactFeedbackStyle = {
  Light: "LIGHT",
  Medium: "MEDIUM",
  Heavy: "HEAVY",
} as const;

export const NotificationFeedbackType = {
  Success: "SUCCESS",
  Warning: "WARNING",
  Error: "ERROR",
} as const;

export async function impactAsync(): Promise<void> {
  return undefined;
}

export async function notificationAsync(): Promise<void> {
  return undefined;
}

export async function selectionAsync(): Promise<void> {
  return undefined;
}
