import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppReleaseChannel } from "../features/auto-updater.js";

export interface DesktopSettings {
  releaseChannel: AppReleaseChannel;
  daemon: {
    manageBuiltInDaemon: boolean;
    keepRunningAfterQuit: boolean;
  };
}

interface DesktopSettingsPatch {
  releaseChannel?: AppReleaseChannel;
  daemon?: Partial<DesktopSettings["daemon"]>;
}

interface PersistedDesktopSettingsDocument {
  version: 1;
  settings: DesktopSettings;
  migrations: {
    legacyRendererSettingsImported: boolean;
  };
}

export interface DesktopSettingsStore {
  get(): Promise<DesktopSettings>;
  patch(patch: unknown): Promise<DesktopSettings>;
  migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings>;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  releaseChannel: "stable",
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: true,
  },
};

const DESKTOP_SETTINGS_FILENAME = "desktop-settings.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceReleaseChannel(value: unknown): AppReleaseChannel | null {
  if (value === "beta") {
    return "beta";
  }
  if (value === "stable") {
    return "stable";
  }
  return null;
}

function coerceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function buildDefaultDocument(): PersistedDesktopSettingsDocument {
  return {
    version: 1,
    settings: {
      releaseChannel: DEFAULT_DESKTOP_SETTINGS.releaseChannel,
      daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon },
    },
    migrations: {
      legacyRendererSettingsImported: false,
    },
  };
}

function coerceDesktopSettings(input: unknown): DesktopSettings {
  const result: DesktopSettings = {
    releaseChannel: DEFAULT_DESKTOP_SETTINGS.releaseChannel,
    daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon },
  };

  if (!isRecord(input)) {
    return result;
  }

  const releaseChannel = coerceReleaseChannel(input.releaseChannel);
  if (releaseChannel) {
    result.releaseChannel = releaseChannel;
  }

  if (isRecord(input.daemon)) {
    const manageBuiltInDaemon = coerceBoolean(input.daemon.manageBuiltInDaemon);
    if (manageBuiltInDaemon !== null) {
      result.daemon.manageBuiltInDaemon = manageBuiltInDaemon;
    }

    const keepRunningAfterQuit = coerceBoolean(input.daemon.keepRunningAfterQuit);
    if (keepRunningAfterQuit !== null) {
      result.daemon.keepRunningAfterQuit = keepRunningAfterQuit;
    }
  }

  return result;
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
  current: DesktopSettings,
  patch: DesktopSettingsPatch,
): DesktopSettings {
  return {
    releaseChannel: patch.releaseChannel ?? current.releaseChannel,
    daemon: { ...current.daemon, ...patch.daemon },
  };
}

function hasLegacyRendererOwnedPatch(patch: DesktopSettingsPatch): boolean {
  return patch.releaseChannel !== undefined || patch.daemon?.manageBuiltInDaemon !== undefined;
}

function coerceDocument(input: unknown): PersistedDesktopSettingsDocument {
  if (!isRecord(input)) {
    return buildDefaultDocument();
  }

  const settings = coerceDesktopSettings(input.settings);
  const migrations = isRecord(input.migrations)
    ? {
        legacyRendererSettingsImported: input.migrations.legacyRendererSettingsImported === true,
      }
    : {
        legacyRendererSettingsImported: false,
      };

  return {
    version: 1,
    settings,
    migrations,
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

  async function loadWritableDocument(): Promise<PersistedDesktopSettingsDocument> {
    const document = await loadDocument();
    await persistDocument(document);
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
      return document.settings;
    },

    async patch(patch: unknown): Promise<DesktopSettings> {
      const current = await loadWritableDocument();
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
      return next;
    },

    async migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings> {
      const current = await initializeLegacyRendererMigration();
      if (current.migrations.legacyRendererSettingsImported) {
        return current.settings;
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
      return next;
    },
  };
}
