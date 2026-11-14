import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HostConfigDocument, PluginListItem } from "@getpaseo/protocol/messages";
import type { PersistedConfig } from "../../persisted-config.js";
import { CONFIG_SECTIONS, readHostSecrets, type RedactedPath } from "./sections.js";

const SettingsEnvelopeSchema = z.object({ version: z.number().int(), values: z.unknown() });

export async function buildHostDocument(input: {
  daemonVersion: string;
  persisted: PersistedConfig;
  plugins: PluginListItem[];
  settingsDirectory: string;
}): Promise<HostConfigDocument> {
  const redacted: RedactedPath[] = readHostSecrets(input.persisted);
  const config: Record<string, unknown> = {};
  for (const section of CONFIG_SECTIONS) {
    const value = section.read(input.persisted, redacted);
    if (value !== undefined) config[section.id] = value;
  }

  const plugins: HostConfigDocument["plugins"] = [];
  const manualPlugins: HostConfigDocument["manualPlugins"] = [];
  for (const plugin of input.plugins) {
    if (!plugin.installation || plugin.installation.identity.kind === "directory") {
      manualPlugins.push({ id: plugin.id, reason: "directory-source" });
    } else {
      plugins.push({ id: plugin.id, enabled: plugin.enabled, installation: plugin.installation });
    }
  }

  const pluginSettings: HostConfigDocument["pluginSettings"] = [];
  for (const plugin of input.plugins) {
    pluginSettings.push(...(await readSavedSettings(input.settingsDirectory, plugin.id)));
  }

  return {
    format: "paseo-host-config",
    version: 1,
    daemonVersion: input.daemonVersion,
    config,
    plugins,
    manualPlugins,
    pluginSettings,
    redacted,
  };
}

async function readSavedSettings(
  settingsDirectory: string,
  pluginId: string,
): Promise<HostConfigDocument["pluginSettings"]> {
  const directory = path.join(settingsDirectory, pluginId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const settings: HostConfigDocument["pluginSettings"] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const file = path.join(directory, name);
    const parsed = SettingsEnvelopeSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) {
      throw new Error(`Plugin settings file ${file} is not a {version, values} settings envelope`);
    }
    settings.push({
      pluginId,
      settingsId: name.slice(0, -".json".length),
      version: parsed.data.version,
      values: parsed.data.values,
    });
  }
  return settings;
}
