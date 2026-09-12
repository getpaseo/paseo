export function describeSandbox(input: { disabled: boolean; launcherReason?: string }): {
  enabled: boolean;
  reason: string;
} {
  return {
    enabled: !input.disabled,
    reason:
      input.launcherReason ?? (input.disabled ? "requested by --no-sandbox" : "Chromium default"),
  };
}
