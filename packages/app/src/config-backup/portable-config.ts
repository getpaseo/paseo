import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  PortableDaemonConfigurationSchema,
  type DaemonConfigImportResponse,
} from "@getpaseo/protocol/messages";
import { z } from "zod";

import type { DesktopSettings } from "@/desktop/settings/desktop-settings";

export const PASEO_CONFIG_BACKUP_FORMAT = "paseo-config-backup";
export const PASEO_CONFIG_BACKUP_VERSION = 1;

const PORTABLE_STORAGE_KEYS = new Set([
  "@paseo:app-settings",
  "@paseo:changes-preferences",
  "@paseo:create-agent-preferences",
  "@paseo:keyboard-shortcut-overrides",
  "@paseo:preferred-editor",
  "@paseo:sidebar-callout-dismissals",
  "sidebar-collapsed-sections",
  "sidebar-project-workspace-order",
  "sidebar-view",
  "workspace-service-route-preferences",
]);
const PORTABLE_STORAGE_PREFIXES = ["@paseo:changes-ship-default:"];
const JSON_STORAGE_KEYS_WITH_PORTABLE_IDS = new Set([
  "sidebar-collapsed-sections",
  "sidebar-project-workspace-order",
  "sidebar-view",
  "workspace-service-route-preferences",
]);

const DesktopSettingsSchema = z.object({
  releaseChannel: z.enum(["stable", "beta"]),
  daemon: z.object({
    manageBuiltInDaemon: z.boolean(),
    keepRunningAfterQuit: z.boolean(),
  }),
});

export const PaseoConfigBackupSchema = z.object({
  format: z.literal(PASEO_CONFIG_BACKUP_FORMAT),
  version: z.literal(PASEO_CONFIG_BACKUP_VERSION),
  exportedAt: z.string(),
  sourceHost: z.object({
    serverId: z.string(),
    label: z.string(),
  }),
  daemon: PortableDaemonConfigurationSchema,
  client: z.object({
    storage: z.record(z.string(), z.string()),
  }),
  desktop: DesktopSettingsSchema.optional(),
});

export type PaseoConfigBackup = z.infer<typeof PaseoConfigBackupSchema>;

interface PortableStorage {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  multiSet(entries: readonly (readonly [string, string])[]): Promise<void>;
}

export interface PortableConfigDeps {
  storage: PortableStorage;
  isDesktop: () => boolean;
  loadDesktopSettings: () => Promise<DesktopSettings>;
  updateDesktopSettings: (settings: DesktopSettings) => Promise<unknown>;
  now: () => string;
}

function isPortableStorageKey(key: string): boolean {
  return (
    PORTABLE_STORAGE_KEYS.has(key) ||
    PORTABLE_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

async function exportPortableStorage(storage: PortableStorage): Promise<Record<string, string>> {
  const keys = (await storage.getAllKeys()).filter(isPortableStorageKey).sort();
  const entries = await storage.multiGet(keys);
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, string] => entry[1] !== null),
  );
}

function remapJsonValue(value: unknown, ids: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") return ids[value] ?? value;
  if (Array.isArray(value)) return value.map((item) => remapJsonValue(item, ids));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [ids[key] ?? key, remapJsonValue(child, ids)]),
  );
}

function remapPersistedJson(raw: string, ids: Readonly<Record<string, string>>): string {
  try {
    return JSON.stringify(remapJsonValue(JSON.parse(raw), ids));
  } catch {
    return raw;
  }
}

function remapShipDefaultKey(key: string, rootPathMap: Readonly<Record<string, string>>): string {
  const prefix = PORTABLE_STORAGE_PREFIXES[0];
  if (!key.startsWith(prefix)) return key;
  const rootPath = key.slice(prefix.length);
  return `${prefix}${rootPathMap[rootPath] ?? rootPath}`;
}

export async function createPaseoConfigBackup(input: {
  client: DaemonClient;
  sourceHost: { serverId: string; label: string };
  deps: PortableConfigDeps;
}): Promise<PaseoConfigBackup> {
  const deps = input.deps;
  const [daemon, storage, desktop] = await Promise.all([
    input.client.exportPortableConfig().then((response) => response.config),
    exportPortableStorage(deps.storage),
    deps.isDesktop() ? deps.loadDesktopSettings() : Promise.resolve(undefined),
  ]);

  return PaseoConfigBackupSchema.parse({
    format: PASEO_CONFIG_BACKUP_FORMAT,
    version: PASEO_CONFIG_BACKUP_VERSION,
    exportedAt: deps.now(),
    sourceHost: input.sourceHost,
    daemon,
    client: { storage },
    ...(desktop ? { desktop } : {}),
  });
}

export function parsePaseoConfigBackup(content: string): PaseoConfigBackup {
  return PaseoConfigBackupSchema.parse(JSON.parse(content));
}

export async function restorePaseoConfigBackup(input: {
  backup: PaseoConfigBackup;
  client: DaemonClient;
  targetServerId: string;
  deps: PortableConfigDeps;
}): Promise<DaemonConfigImportResponse["payload"]> {
  const deps = input.deps;
  const backup = PaseoConfigBackupSchema.parse(input.backup);
  const result = await input.client.importPortableConfig(backup.daemon);
  const idMap = {
    ...result.projectIdMap,
    [backup.sourceHost.serverId]: input.targetServerId,
  };
  const storageEntries = Object.entries(backup.client.storage)
    .filter(([key]) => isPortableStorageKey(key))
    .map(([key, raw]) => {
      const remappedKey = remapShipDefaultKey(key, result.rootPathMap);
      const remappedValue = JSON_STORAGE_KEYS_WITH_PORTABLE_IDS.has(key)
        ? remapPersistedJson(raw, idMap)
        : raw;
      return [remappedKey, remappedValue] as const;
    });

  await deps.storage.multiSet(storageEntries);
  if (deps.isDesktop() && backup.desktop) {
    await deps.updateDesktopSettings(backup.desktop);
  }
  return result;
}
