import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AppReleaseChannel } from "../features/auto-updater.js";

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

const NotificationsSchema = z
  .looseObject({
    playSound: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.notifications.playSound),
  })
  .catch(() => ({ ...DEFAULT_DESKTOP_SETTINGS.notifications }));

const DaemonSchema = z
  .looseObject({
    manageBuiltInDaemon: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.daemon.manageBuiltInDaemon),
    keepRunningAfterQuit: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.daemon.keepRunningAfterQuit),
  })
  .catch(() => ({ ...DEFAULT_DESKTOP_SETTINGS.daemon }));

const DesktopSettingsSchema = z
  .looseObject({
    releaseChannel: ReleaseChannelSchema.catch(DEFAULT_DESKTOP_SETTINGS.releaseChannel),
    notifications: NotificationsSchema,
    daemon: DaemonSchema,
  })
  .catch(() => buildDefaultSettings());

const MigrationsSchema = z
  .looseObject({
    legacyRendererSettingsImported: z.boolean().catch(false),
    daemonStopOnQuitDefaultApplied: z.boolean().catch(false),
  })
  .catch(() => ({
    legacyRendererSettingsImported: false,
    daemonStopOnQuitDefaultApplied: false,
  }));

const PersistedDocumentSchema = z
  .looseObject({
    version: z.literal(1).catch(1),
    settings: DesktopSettingsSchema,
    migrations: MigrationsSchema,
  })
  .catch(() => buildDefaultDocument());

type StoredDesktopSettings = z.output<typeof DesktopSettingsSchema>;
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

function buildDefaultSettings(): StoredDesktopSettings {
  return {
    releaseChannel: DEFAULT_DESKTOP_SETTINGS.releaseChannel,
    notifications: { ...DEFAULT_DESKTOP_SETTINGS.notifications },
    daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon },
  };
}

function buildDefaultDocument(): PersistedDesktopSettingsDocument {
  return {
    version: 1,
    settings: buildDefaultSettings(),
    migrations: {
      legacyRendererSettingsImported: false,
      daemonStopOnQuitDefaultApplied: true,
    },
  };
}

function toDesktopSettings(stored: StoredDesktopSettings): DesktopSettings {
  return {
    releaseChannel: stored.releaseChannel,
    notifications: { playSound: stored.notifications.playSound },
    daemon: {
      manageBuiltInDaemon: stored.daemon.manageBuiltInDaemon,
      keepRunningAfterQuit: stored.daemon.keepRunningAfterQuit,
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
    if (playSound !== null) {
      patch.notifications = { playSound };
    }
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

function mergeDesktopSettings(
  current: StoredDesktopSettings,
  patch: DesktopSettingsPatch,
): StoredDesktopSettings {
  return {
    ...current,
    releaseChannel: patch.releaseChannel ?? current.releaseChannel,
    notifications: { ...current.notifications, ...patch.notifications },
    daemon: { ...current.daemon, ...patch.daemon },
  };
}

function hasLegacyRendererOwnedPatch(patch: DesktopSettingsPatch): boolean {
  return patch.releaseChannel !== undefined || patch.daemon?.manageBuiltInDaemon !== undefined;
}

function coerceDocument(input: unknown): PersistedDesktopSettingsDocument {
  const document = PersistedDocumentSchema.parse(input);
  if (document.migrations.daemonStopOnQuitDefaultApplied) {
    return document;
  }

  return {
    ...document,
    settings: {
      ...document.settings,
      daemon: {
        ...document.settings.daemon,
        keepRunningAfterQuit: DEFAULT_DESKTOP_SETTINGS.daemon.keepRunningAfterQuit,
      },
    },
    migrations: { ...document.migrations, daemonStopOnQuitDefaultApplied: true },
  };
}

export function createDesktopSettingsStore({
  userDataPath,
}: {
  userDataPath: string;
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

  async function loadDocument(): Promise<PersistedDesktopSettingsDocument> {
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
      const document = buildDefaultDocument();
      await persistDocument(document);
      return document;
    }
    const document = coerceDocument(JSON.parse(raw));
    cachedDocument = document;
    return document;
  }

  async function initializeLegacyRendererMigration(): Promise<PersistedDesktopSettingsDocument> {
    try {
      return await loadDocument();
    } catch {
      const document = buildDefaultDocument();
      await persistDocument(document);
      return document;
    }
  }

  return {
    async get(): Promise<DesktopSettings> {
      const document = await loadDocument();
      return toDesktopSettings(document.settings);
    },

    async patch(patch: unknown): Promise<DesktopSettings> {
      const current = await loadDocument();
      const coercedPatch = coerceDesktopSettingsPatch(patch);
      const next = mergeDesktopSettings(current.settings, coercedPatch);
      await persistDocument({
        ...current,
        settings: next,
        migrations: {
          ...current.migrations,
          legacyRendererSettingsImported:
            current.migrations.legacyRendererSettingsImported ||
            hasLegacyRendererOwnedPatch(coercedPatch),
        },
      });
      return toDesktopSettings(next);
    },

    async migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings> {
      const current = await initializeLegacyRendererMigration();
      if (current.migrations.legacyRendererSettingsImported) {
        return toDesktopSettings(current.settings);
      }

      const next = mergeDesktopSettings(
        current.settings,
        pickDesktopSettingsFromLegacyRendererSettings(legacySettings),
      );
      await persistDocument({
        ...current,
        settings: next,
        migrations: {
          ...current.migrations,
          legacyRendererSettingsImported: true,
        },
      });
      return toDesktopSettings(next);
    },
  };
}
