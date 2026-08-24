import type { DesktopSettingsStore } from "./desktop-settings.js";

export type DesktopCommandHandler = (args?: Record<string, unknown>) => unknown;

// Approving a link scheme is user consent, gathered by the dialog the main-process
// opener shows. Reaching this command bus is not that consent, so the renderer may not
// grant itself an approval. Reading the list back through `get` stays allowed.
function withoutSchemeApprovals(args?: Record<string, unknown>): Record<string, unknown> {
  if (!args) {
    return {};
  }
  const forwarded = { ...args };
  delete forwarded.links;
  return forwarded;
}

export function createDesktopSettingsCommandHandlers({
  settingsStore,
}: {
  settingsStore: DesktopSettingsStore;
}): Record<string, DesktopCommandHandler> {
  return {
    get_desktop_settings: () => settingsStore.get(),
    patch_desktop_settings: (args) => settingsStore.patch(withoutSchemeApprovals(args)),
    migrate_legacy_desktop_settings: (args) => settingsStore.migrateLegacyRendererSettings(args),
  };
}
