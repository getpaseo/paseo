import { findLayerableSetting, type SeedValueKind } from "./registry";
import type { SettingsSeed } from "./types";

export interface SettingsKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface LayeredSettingsStorageDeps {
  base: SettingsKeyValueStorage;
  loadSeed: () => Promise<SettingsSeed | null>;
}

/** A write was rejected because the seed layer, which the app cannot edit, owns the value. */
export class SeedShadowedError extends Error {
  readonly storageKey: string;
  readonly seedPath: string;
  /** The dotted path inside the stored value that the seed owns, when the block is per-entry. */
  readonly entry?: string;

  constructor(params: { message: string; storageKey: string; seedPath: string; entry?: string }) {
    super(params.message);
    this.name = "SeedShadowedError";
    this.storageKey = params.storageKey;
    this.seedPath = params.seedPath;
    this.entry = params.entry;
  }
}

interface ResolvedObjectSeed {
  kind: "struct" | "record";
  storageKey: string;
  seedPath: string;
  value: Record<string, unknown>;
}

interface ResolvedScalarSeed {
  kind: "scalar";
  storageKey: string;
  seedPath: string;
  value: string;
}

type ResolvedSeed = ResolvedObjectSeed | ResolvedScalarSeed;

export function createLayeredSettingsStorage(
  deps: LayeredSettingsStorageDeps,
): SettingsKeyValueStorage {
  async function resolveSeed(storageKey: string): Promise<ResolvedSeed | null> {
    const setting = findLayerableSetting(storageKey);
    if (!setting) {
      return null;
    }
    const seed = await deps.loadSeed();
    if (!seed || !Object.hasOwn(seed.app, setting.seedField)) {
      return null;
    }

    const value = seed.app[setting.seedField];
    if (setting.kind === "scalar") {
      if (typeof value !== "string") {
        warnWrongShape(setting.seedField, setting.kind, seed.path);
        return null;
      }
      return { kind: "scalar", storageKey, seedPath: seed.path, value };
    }
    if (!isRecord(value)) {
      warnWrongShape(setting.seedField, setting.kind, seed.path);
      return null;
    }
    return { kind: setting.kind, storageKey, seedPath: seed.path, value };
  }

  return {
    async getItem(key: string): Promise<string | null> {
      const seed = await resolveSeed(key);
      const local = await deps.base.getItem(key);
      if (!seed) {
        return local;
      }
      if (seed.kind === "scalar") {
        return local ?? seed.value;
      }

      const parsed = parseStoredObject(local);
      if (parsed === null) {
        console.error(
          `[Settings] Ignoring the seed layer for "${key}": the stored value is not a JSON object.`,
        );
        return local;
      }
      return JSON.stringify(deepMerge(seed.value, parsed));
    },

    async setItem(key: string, value: string): Promise<void> {
      const seed = await resolveSeed(key);
      if (!seed) {
        await deps.base.setItem(key, value);
        return;
      }
      if (seed.kind === "scalar") {
        // A local copy of the seed value would pin it, so drop it and let the seed show through.
        if (value === seed.value) {
          await deps.base.removeItem(key);
          return;
        }
        await deps.base.setItem(key, value);
        return;
      }

      const desired = parseStoredObject(value);
      if (desired === null) {
        console.error(
          `[Settings] Writing "${key}" without the seed layer: the value is not a JSON object.`,
        );
        await deps.base.setItem(key, value);
        return;
      }

      if (seed.kind === "record") {
        const removed = findRemovedSeedPaths(desired, seed.value);
        if (removed.length > 0) {
          throw new SeedShadowedError({
            message: `[Settings] Cannot remove "${removed[0]}": it is defined in ${seed.seedPath}. Change it there instead.`,
            storageKey: key,
            seedPath: seed.seedPath,
            entry: removed[0],
          });
        }
      }

      await deps.base.setItem(key, JSON.stringify(deepDiff(desired, seed.value)));
    },

    async removeItem(key: string): Promise<void> {
      const seed = await resolveSeed(key);
      if (seed && seedHasValues(seed)) {
        throw new SeedShadowedError({
          message: `[Settings] Cannot reset "${key}": values are defined in ${seed.seedPath}. Change them there instead.`,
          storageKey: key,
          seedPath: seed.seedPath,
        });
      }
      await deps.base.removeItem(key);
    },
  };
}

function seedHasValues(seed: ResolvedSeed): boolean {
  return seed.kind === "scalar" || Object.keys(seed.value).length > 0;
}

function warnWrongShape(seedField: string, kind: SeedValueKind, seedPath: string): void {
  const expected = kind === "scalar" ? "a string" : "an object";
  console.error(`[Settings] Ignoring "${seedField}" in ${seedPath}: expected ${expected}.`);
}

/** `null` means the stored value cannot participate in layering (missing keys parse as `{}`). */
function parseStoredObject(stored: string | null): Record<string, unknown> | null {
  if (stored === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Same semantics as the daemon's config merge: objects merge recursively, everything else replaces. */
export function deepMerge(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;
    const currentValue = next[key];
    if (isRecord(currentValue) && isRecord(patchValue)) {
      next[key] = deepMerge(currentValue, patchValue);
      continue;
    }
    next[key] = patchValue;
  }
  return next;
}

/** The part of `desired` the lower layer does not already provide. */
export function deepDiff(
  desired: Record<string, unknown>,
  lowerLayer: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const [key, desiredValue] of Object.entries(desired)) {
    const lowerValue = lowerLayer[key];
    if (isDeepEqual(desiredValue, lowerValue)) continue;
    if (isRecord(desiredValue) && isRecord(lowerValue)) {
      const nested = deepDiff(desiredValue, lowerValue);
      if (Object.keys(nested).length > 0) diff[key] = nested;
      continue;
    }
    diff[key] = desiredValue;
  }
  return diff;
}

/** Dotted paths the seed defines that `desired` dropped — a deletion the local layer cannot express. */
function findRemovedSeedPaths(
  desired: Record<string, unknown>,
  seedValue: Record<string, unknown>,
  prefix: string[] = [],
): string[] {
  const removed: string[] = [];
  for (const [key, seedEntry] of Object.entries(seedValue)) {
    const path = [...prefix, key];
    if (!Object.hasOwn(desired, key)) {
      removed.push(path.join("."));
      continue;
    }
    const desiredEntry = desired[key];
    if (isRecord(seedEntry) && isRecord(desiredEntry)) {
      removed.push(...findRemovedSeedPaths(desiredEntry, seedEntry, path));
    }
  }
  return removed;
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => isDeepEqual(item, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && isDeepEqual(a[key], b[key]));
}
