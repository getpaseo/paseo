import { createHash } from "node:crypto";
import type {
  ProviderCatalog,
  ProviderLaunch,
  ProviderModel,
  ProviderMode,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { probe } from "./process.js";
import { AntigravityError } from "./wire.js";

const CATALOG_CACHE_TTL_MS = 5 * 60_000;

interface CachedCatalog {
  readonly catalog: ProviderCatalog;
  readonly expiresAt: number;
  readonly versionVerified: boolean;
}

const catalogCache = new Map<string, CachedCatalog>();
const inFlightCatalogs = new Map<string, Promise<ProviderCatalog>>();
const inFlightStatuses = new Map<string, Promise<ProviderStatus>>();

export function launchCacheKey(launch: ProviderLaunch): string {
  const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify([launch.command, launch.args, env]))
    .digest("hex");
}

const modes: readonly ProviderMode[] = [
  {
    id: "full-access",
    icon: "ShieldOff",
    colorTier: "dangerous",
    label: "Full access",
    description:
      "Antigravity cannot ask for permission when another app drives it. Paseo starts it with --dangerously-skip-permissions.",
    isUnattended: true,
  },
];

export async function getCatalog(
  launch: ProviderLaunch,
  cwd?: string,
  options?: { refresh?: boolean },
): Promise<ProviderCatalog> {
  const key = launchCacheKey(launch);
  if (!options?.refresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.catalog;
    }
    const existing = inFlightCatalogs.get(key);
    if (existing) {
      return existing;
    }
  }
  const task = (async () => {
    try {
      const output = await probe({ launch, args: ["models"], cwd });
      const models: ProviderModel[] = [];
      for (const line of output.trim().split(/\r?\n/)) {
        const [id, label, ...extra] = line.split("\t");
        if (!id || !label || extra.length > 0)
          throw new AntigravityError("Invalid `agy models` output", "INVALID_CATALOG");
        if (models.some((model) => model.id === id))
          throw new AntigravityError(`Duplicate Antigravity model: ${id}`, "INVALID_CATALOG");
        models.push({ id, label });
      }
      const catalog: ProviderCatalog = {
        models,
        modes,
        thinkingOptions: [],
        defaultMode: "full-access",
      };
      const versionVerified = catalogCache.get(key)?.versionVerified ?? false;
      catalogCache.set(key, {
        catalog,
        expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
        versionVerified,
      });
      return catalog;
    } catch (error) {
      catalogCache.delete(key);
      throw error;
    }
  })().finally(() => {
    if (inFlightCatalogs.get(key) === task) {
      inFlightCatalogs.delete(key);
    }
  });
  inFlightCatalogs.set(key, task);
  return task;
}

export async function getStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  const key = launchCacheKey(launch);
  const cached = catalogCache.get(key);
  if (cached && cached.versionVerified && cached.expiresAt > Date.now()) {
    return { available: true };
  }
  const existing = inFlightStatuses.get(key);
  if (existing) {
    return existing;
  }
  const task = (async (): Promise<ProviderStatus> => {
    try {
      const version = (await probe({ launch, args: ["--version"] })).trim();
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      if (!match)
        return {
          available: false,
          diagnostic: "Could not read the Antigravity version. Update `agy` to 1.1.15 or later.",
        };
      const [, major, minor, patch] = match.map(Number);
      const supported = major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 15)));
      if (!supported)
        return {
          available: false,
          diagnostic: `Antigravity ${version} is unsupported. Update \`agy\` to 1.1.15 or later.`,
        };
      const catalog = await getCatalog(launch);
      const current = catalogCache.get(key);
      catalogCache.set(key, {
        catalog,
        expiresAt: current?.expiresAt ?? Date.now() + CATALOG_CACHE_TTL_MS,
        versionVerified: true,
      });
      return { available: true };
    } catch (error) {
      catalogCache.delete(key);
      if (!(error instanceof AntigravityError)) throw error;
      return { available: false, diagnostic: error.message };
    }
  })().finally(() => {
    if (inFlightStatuses.get(key) === task) {
      inFlightStatuses.delete(key);
    }
  });
  inFlightStatuses.set(key, task);
  return task;
}

export function validateSelection(
  config: { model?: string; mode?: string; thinkingOption?: string },
  catalog: ProviderCatalog,
): void {
  if (config.model && !catalog.models.some((model) => model.id === config.model))
    throw new AntigravityError(`Unknown Antigravity model: ${config.model}`, "INVALID_MODEL");
  if (config.mode && !catalog.modes.some((mode) => mode.id === config.mode))
    throw new AntigravityError(`Unknown Antigravity mode: ${config.mode}`, "INVALID_MODE");
  if (config.thinkingOption)
    throw new AntigravityError(
      "Antigravity effort is selected through the model ID",
      "UNSUPPORTED_THINKING",
    );
}
