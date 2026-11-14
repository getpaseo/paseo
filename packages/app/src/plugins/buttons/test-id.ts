/** Stable semantic hook for app-wide styling plugins, independent of registration order. */
export function pluginButtonTestId(installationId: string, buttonId: string): string {
  return `plugin-button-${installationId}-${buttonId}`;
}
