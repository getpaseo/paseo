/** Stable semantic hook for app-wide styling plugins. */
export function pluginButtonTestId(key: number | string): string {
  return `plugin-button-${key}`;
}
