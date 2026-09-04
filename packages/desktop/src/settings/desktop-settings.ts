import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AppReleaseChannel } from "../features/auto-updater.js";
import { loadSettingsSeed, type SettingsSeedDocument } from "./settings-seed.js";

export interface DesktopSettings {
  releaseChannel: AppReleaseChannel;
  notifications: {
    playSound: boolean;
  };
  daemon: {
    manageBuiltInDaemon: boolean;
    keepRunningAfterQuit: boolean;
  };
}

interface DesktopSettingsPatch {
  releaseChannel?: AppReleaseChannel;
  notifications?: Partial<DesktopSettings["notifications"]>;
  daemon?: Partial<DesktopSettings["daemon"]>;
}

export interface DesktopSettingsStore {
  get(): Promise<DesktopSettings>;
  patch(patch: unknown): Promise<DesktopSettings>;
  migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings>;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  releaseChannel: "stable",
  notifications: {
    playSound: true,
  },
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: false,
  },
};

const DESKTOP_SETTINGS_FILENAME = "desktop-settings.json";

const ReleaseChannelSchema = z.enum(["stable", "beta"]);

// Without a seed file this holds the full settings, exactly as older versions wrote it. With a
// seed file it holds only the diff against defaults ⊕ seed, so later seed edits keep applying to
// everything the user has not overridden. Either way every key is optional and unmodelled keys
// survive the round trip, so a build that writes settings this one does not know does not lose
// them.
const StoredSettingsSchema = z
  .looseObject({
    releaseChannel: ReleaseChannelSchema.optional().catch(undefined),
    notifications: z
      .looseObject({ playSound: z.boolean().optional().catch(undefined) })
      .optional()
      .catch(undefined),
    daemon: z
      .looseObject({
        manageBuiltInDaemon: z.boolean().optional().catch(undefined),
        keepRunningAfterQuit: z.boolean().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .catch(() => ({}));

const MigrationsSchema = z
  .looseObject({
    legacyRendererSettingsImported: z.boolean().catch(false),
    // Installs created before the stop-on-quit default persisted the old
    // `keepRunningAfterQuit: true` default to disk, so the new default alone
    // would only reach fresh installs. Reset it once; a later explicit toggle
    // persists this flag and is never overridden again.
    daemonStopOnQuitDefaultApplied: z.boolean().catch(false),
  })
  .catch(() => ({
    legacyRendererSettingsImported: false,
    daemonStopOnQuitDefaultApplied: false,
  }));

const PersistedDocumentSchema = z
  .looseObject({
    version: z.literal(1).catch(1),
    settings: StoredSettingsSchema,
    migrations: MigrationsSchema,
  })
  .catch(() => ({
    version: 1 as const,
    settings: {},
    migrations: { legacyRendererSettingsImported: false, daemonStopOnQuitDefaultApplied: true },
  }));

type StoredSettings = z.output<typeof StoredSettingsSchema>;
type PersistedDesktopSettingsDocument = z.output<typeof PersistedDocumentSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceReleaseChannel(value: unknown): AppReleaseChannel | null {
  const result = ReleaseChannelSchema.safeParse(value);
  return result.success ? result.data : null;
}

function coerceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function cloneDefaultSettings(): DesktopSettings {
  return {
    releaseChannel: DEFAULT_DESKTOP_SETTINGS.releaseChannel,
    notifications: { ...DEFAULT_DESKTOP_SETTINGS.notifications },
    daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon },
  };
}

function buildDefaultStoredSettings(hasSeed: boolean): StoredSettings {
  if (hasSeed) {
    return {};
  }
  const defaults = cloneDefaultSettings();
  return {
    releaseChannel: defaults.releaseChannel,
    notifications: { ...defaults.notifications },
    daemon: { ...defaults.daemon },
  };
}

function buildDefaultDocument(hasSeed: boolean): PersistedDesktopSettingsDocument {
  return {
    version: 1,
    settings: buildDefaultStoredSettings(hasSeed),
    migrations: {
      legacyRendererSettingsImported: false,
      daemonStopOnQuitDefaultApplied: true,
    },
  };
}

function coerceDesktopSettingsPatch(input: unknown): DesktopSettingsPatch {
  if (!isRecord(input)) {
    return {};
  }

  const patch: DesktopSettingsPatch = {};
  const releaseChannel = coerceReleaseChannel(input.releaseChannel);
  if (releaseChannel) {
    patch.releaseChannel = releaseChannel;
  }

  if (isRecord(input.notifications)) {
    const playSound = coerceBoolean(input.notifications.playSound);
    if (playSound !== null) patch.notifications = { playSound };
  }

  if (isRecord(input.daemon)) {
    const daemonPatch: Partial<DesktopSettings["daemon"]> = {};
    const manageBuiltInDaemon = coerceBoolean(input.daemon.manageBuiltInDaemon);
    if (manageBuiltInDaemon !== null) {
      daemonPatch.manageBuiltInDaemon = manageBuiltInDaemon;
    }
    const keepRunningAfterQuit = coerceBoolean(input.daemon.keepRunningAfterQuit);
    if (keepRunningAfterQuit !== null) {
      daemonPatch.keepRunningAfterQuit = keepRunningAfterQuit;
    }
    if (Object.keys(daemonPatch).length > 0) {
      patch.daemon = daemonPatch;
    }
  }

  return patch;
}

function pickDesktopSettingsFromLegacyRendererSettings(
  legacySettings: unknown,
): DesktopSettingsPatch {
  if (!isRecord(legacySettings)) {
    return {};
  }

  const patch: DesktopSettingsPatch = {};
  const releaseChannel = coerceReleaseChannel(legacySettings.releaseChannel);
  if (releaseChannel) {
    patch.releaseChannel = releaseChannel;
  }

  const manageBuiltInDaemon = coerceBoolean(legacySettings.manageBuiltInDaemon);
  if (manageBuiltInDaemon !== null) {
    patch.daemon = { manageBuiltInDaemon };
  }

  return patch;
}

/** Every modelled key resolved against `base`, so the result is a complete settings object. */
function mergeDesktopSettings(
  base: DesktopSettings,
  patch: DesktopSettingsPatch | StoredSettings,
): DesktopSettings {
  return {
    releaseChannel: patch.releaseChannel ?? base.releaseChannel,
    notifications: {
      playSound: patch.notifications?.playSound ?? base.notifications.playSound,
    },
    daemon: {
      manageBuiltInDaemon: patch.daemon?.manageBuiltInDaemon ?? base.daemon.manageBuiltInDaemon,
      keepRunningAfterQuit: patch.daemon?.keepRunningAfterQuit ?? base.daemon.keepRunningAfterQuit,
    },
  };
}

function diffDesktopSettings(
  desired: DesktopSettings,
  base: DesktopSettings,
): DesktopSettingsPatch {
  const delta: DesktopSettingsPatch = {};

  if (desired.releaseChannel !== base.releaseChannel) {
    delta.releaseChannel = desired.releaseChannel;
  }

  if (desired.notifications.playSound !== base.notifications.playSound) {
    delta.notifications = { playSound: desired.notifications.playSound };
  }

  const daemon: Partial<DesktopSettings["daemon"]> = {};
  if (desired.daemon.manageBuiltInDaemon !== base.daemon.manageBuiltInDaemon) {
    daemon.manageBuiltInDaemon = desired.daemon.manageBuiltInDaemon;
  }
  if (desired.daemon.keepRunningAfterQuit !== base.daemon.keepRunningAfterQuit) {
    daemon.keepRunningAfterQuit = desired.daemon.keepRunningAfterQuit;
  }
  if (Object.keys(daemon).length > 0) {
    delta.daemon = daemon;
  }

  return delta;
}

/** Replaces the keys this build models and keeps every key it does not. */
function mergeUnmodelled(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
  modelled: readonly string[],
): Record<string, unknown> | undefined {
  const carried: Record<string, unknown> = { ...previous };
  for (const key of modelled) delete carried[key];
  const merged = { ...carried, ...next };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The settings to write: `next` for everything this build models, and whatever the stored
 * document already held for everything it does not.
 */
function buildStoredSettings(previous: StoredSettings, next: DesktopSettingsPatch): StoredSettings {
  const {
    releaseChannel: _releaseChannel,
    notifications: previousNotifications,
    daemon: previousDaemon,
    ...unmodelled
  } = previous;
  const stored: StoredSettings = { ...unmodelled };

  if (next.releaseChannel !== undefined) {
    stored.releaseChannel = next.releaseChannel;
  }
  const notifications = mergeUnmodelled(previousNotifications, next.notifications, ["playSound"]);
  if (notifications) {
    stored.notifications = notifications;
  }
  const daemon = mergeUnmodelled(previousDaemon, next.daemon, [
    "manageBuiltInDaemon",
    "keepRunningAfterQuit",
  ]);
  if (daemon) {
    stored.daemon = daemon;
  }

  return stored;
}

function hasLegacyRendererOwnedPatch(patch: DesktopSettingsPatch): boolean {
  return patch.releaseChannel !== undefined || patch.daemon?.manageBuiltInDaemon !== undefined;
}

// Drops the stored keep-running override so the value falls back to the layer
// underneath it: the seed when there is one, otherwise the app default.
function withoutKeepRunningAfterQuit(settings: StoredSettings): StoredSettings {
  if (settings.daemon?.keepRunningAfterQuit === undefined) {
    return settings;
  }

  const { keepRunningAfterQuit: _dropped, ...daemon } = settings.daemon;
  const next: StoredSettings = { ...settings };
  if (Object.keys(daemon).length > 0) {
    next.daemon = daemon;
  } else {
    delete next.daemon;
  }
  return next;
}

function coerceDocument(input: unknown, hasSeed: boolean): PersistedDesktopSettingsDocument {
  if (!isRecord(input)) {
    return buildDefaultDocument(hasSeed);
  }

  const document = PersistedDocumentSchema.parse(input);
  if (document.migrations.daemonStopOnQuitDefaultApplied) {
    return document;
  }

  return {
    ...document,
    settings: withoutKeepRunningAfterQuit(document.settings),
    migrations: { ...document.migrations, daemonStopOnQuitDefaultApplied: true },
  };
}

interface ResolvedDesktopSettings {
  document: PersistedDesktopSettingsDocument;
  /** Defaults merged with the seed layer; the floor the local delta is diffed against. */
  base: DesktopSettings;
  /** `base` merged with the locally persisted delta. */
  effective: DesktopSettings;
  hasSeed: boolean;
}

export function createDesktopSettingsStore({
  userDataPath,
  loadSeed = () => loadSettingsSeed({ userDataPath }),
}: {
  userDataPath: string;
  loadSeed?: () => Promise<SettingsSeedDocument | null>;
}): DesktopSettingsStore {
  const filePath = path.join(userDataPath, DESKTOP_SETTINGS_FILENAME);
  let cachedDocument: PersistedDesktopSettingsDocument | null = null;
  let persistQueue: Promise<void> = Promise.resolve();

  async function persistDocument(document: PersistedDesktopSettingsDocument): Promise<void> {
    const write = async () => {
      await mkdir(userDataPath, { recursive: true });
      const tempFilePath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
      await writeFile(tempFilePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(tempFilePath, filePath);
      cachedDocument = document;
    };
    const queued = persistQueue.then(write, write);
    persistQueue = queued.catch(() => undefined);
    await queued;
  }

  async function loadDocument(hasSeed: boolean): Promise<PersistedDesktopSettingsDocument> {
    if (cachedDocument) {
      return cachedDocument;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      const document = buildDefaultDocument(hasSeed);
      await persistDocument(document);
      return document;
    }
    const document = coerceDocument(JSON.parse(raw), hasSeed);
    cachedDocument = document;
    return document;
  }

  // An unreadable seed must not take desktop settings down with it: they gate
  // built-in daemon management at startup.
  async function loadSeedBase(): Promise<{ base: DesktopSettings; hasSeed: boolean }> {
    let seed: SettingsSeedDocument | null;
    try {
      seed = await loadSeed();
    } catch (error) {
      console.error("[desktop-settings] Ignoring unreadable settings seed:", error);
      return { base: cloneDefaultSettings(), hasSeed: false };
    }

    if (!seed) {
      return { base: cloneDefaultSettings(), hasSeed: false };
    }
    return {
      base: mergeDesktopSettings(cloneDefaultSettings(), coerceDesktopSettingsPatch(seed.desktop)),
      hasSeed: true,
    };
  }

  async function resolveSettings(): Promise<ResolvedDesktopSettings> {
    const { base, hasSeed } = await loadSeedBase();
    const document = await loadDocument(hasSeed);
    return {
      document,
      base,
      hasSeed,
      effective: mergeDesktopSettings(base, document.settings),
    };
  }

  async function persistSettings(
    resolved: ResolvedDesktopSettings,
    desired: DesktopSettings,
    migrations: PersistedDesktopSettingsDocument["migrations"],
  ): Promise<void> {
    await persistDocument({
      ...resolved.document,
      version: 1,
      settings: buildStoredSettings(
        resolved.document.settings,
        resolved.hasSeed ? diffDesktopSettings(desired, resolved.base) : desired,
      ),
      migrations,
    });
  }

  async function resolveWritableSettings(): Promise<ResolvedDesktopSettings> {
    const resolved = await resolveSettings();
    await persistSettings(resolved, resolved.effective, resolved.document.migrations);
    return resolved;
  }

  async function initializeLegacyRendererMigration(): Promise<ResolvedDesktopSettings> {
    try {
      return await resolveSettings();
    } catch {
      const { base, hasSeed } = await loadSeedBase();
      const document = buildDefaultDocument(hasSeed);
      await persistDocument(document);
      return { document, base, hasSeed, effective: mergeDesktopSettings(base, document.settings) };
    }
  }

  return {
    async get(): Promise<DesktopSettings> {
      const resolved = await resolveSettings();
      return resolved.effective;
    },

    async patch(patch: unknown): Promise<DesktopSettings> {
      const current = await resolveWritableSettings();
      const coercedPatch = coerceDesktopSettingsPatch(patch);
      const next = mergeDesktopSettings(current.effective, coercedPatch);
      await persistSettings(current, next, {
        ...current.document.migrations,
        legacyRendererSettingsImported:
          current.document.migrations.legacyRendererSettingsImported ||
          hasLegacyRendererOwnedPatch(coercedPatch),
      });
      return next;
    },

    async migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings> {
      const current = await initializeLegacyRendererMigration();
      if (current.document.migrations.legacyRendererSettingsImported) {
        return current.effective;
      }

      const next = mergeDesktopSettings(
        current.effective,
        pickDesktopSettingsFromLegacyRendererSettings(legacySettings),
      );
      await persistSettings(current, next, {
        ...current.document.migrations,
        legacyRendererSettingsImported: true,
      });
      return next;
    },
  };
}
