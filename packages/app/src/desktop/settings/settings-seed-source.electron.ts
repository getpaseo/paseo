import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { SettingsSeed } from "@/storage/settings-seed/types";

/**
 * One IPC round-trip per page load. Editing the seed file takes effect on reload, which matches
 * how the daemon picks up imported config layers.
 */
let pending: Promise<SettingsSeed | null> | undefined;

export function loadSettingsSeed(): Promise<SettingsSeed | null> {
  pending ??= requestSettingsSeed();
  return pending;
}

async function requestSettingsSeed(): Promise<SettingsSeed | null> {
  try {
    const result = await invokeDesktopCommand<unknown>("get_settings_seed");
    return parseSettingsSeed(result);
  } catch (err) {
    console.error("[Settings] Failed to read the settings seed file:", err);
    return null;
  }
}

function parseSettingsSeed(result: unknown): SettingsSeed | null {
  if (result === null || result === undefined) {
    return null;
  }
  if (typeof result !== "object" || Array.isArray(result)) {
    console.error("[Settings] Ignoring settings seed: expected an object, got", result);
    return null;
  }
  const { path, app } = result as { path?: unknown; app?: unknown };
  if (typeof path !== "string" || typeof app !== "object" || app === null || Array.isArray(app)) {
    console.error("[Settings] Ignoring settings seed: missing a path or app section.");
    return null;
  }
  return { path, app: app as Record<string, unknown> };
}
