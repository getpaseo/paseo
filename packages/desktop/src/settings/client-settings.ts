import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The writable base layer for renderer preferences on desktop. Same field names and value shapes
 * as the seed's `app` section, so one file format describes both layers and a user can copy a
 * value out of `settings.json` into `settings-seed.json` unchanged.
 */
export interface ClientSettingsDocument {
  version: 1;
  app: Record<string, unknown>;
}

export const CLIENT_SETTINGS_FILENAME = "settings.json";

export interface ClientSettingsStore {
  /** `null` when the file does not exist yet, which is what triggers the renderer's migration. */
  get(): Promise<ClientSettingsDocument | null>;
  /** `null` deletes the field. */
  setField(field: string, value: unknown): Promise<ClientSettingsDocument>;
  /** Writes `entries` only when there is no file yet; returns whichever document now exists. */
  initialize(entries: Record<string, unknown>): Promise<ClientSettingsDocument>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

export function getClientSettingsPath(userDataPath: string): string {
  return path.resolve(userDataPath, CLIENT_SETTINGS_FILENAME);
}

function emptyDocument(): ClientSettingsDocument {
  return { version: 1, app: {} };
}

export function createClientSettingsStore({
  userDataPath,
}: {
  userDataPath: string;
}): ClientSettingsStore {
  const filePath = getClientSettingsPath(userDataPath);
  // Every operation is a read-modify-write, so the whole operation queues, not just its write.
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Read fresh on every call so an external edit — a dotfiles script, another window — applies on
   * the next reload instead of losing to a stale in-process copy.
   */
  async function read(): Promise<ClientSettingsDocument | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[ClientSettings] Failed to read ${filePath}: ${message}`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[ClientSettings] Invalid JSON in ${filePath}: ${message}`, { cause: error });
    }

    if (!isRecord(parsed)) {
      throw new Error(`[ClientSettings] Expected a JSON object at the root of ${filePath}`);
    }
    if (!isRecord(parsed.app)) {
      throw new Error(`[ClientSettings] Expected an "app" object in ${filePath}`);
    }

    return { version: 1, app: parsed.app };
  }

  async function write(document: ClientSettingsDocument): Promise<void> {
    await mkdir(userDataPath, { recursive: true });
    const tempFilePath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(tempFilePath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempFilePath, filePath);
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    get(): Promise<ClientSettingsDocument | null> {
      return serialize(read);
    },

    setField(field: string, value: unknown): Promise<ClientSettingsDocument> {
      return serialize(async () => {
        const document = (await read()) ?? emptyDocument();
        if (value === null || value === undefined) {
          delete document.app[field];
        } else {
          document.app[field] = value;
        }
        await write(document);
        return document;
      });
    },

    initialize(entries: Record<string, unknown>): Promise<ClientSettingsDocument> {
      return serialize(async () => {
        // The file's existence is what ends migration, so never overwrite one that is already
        // there — a second window racing the first must adopt it, not replace it.
        const existing = await read();
        if (existing) {
          return existing;
        }
        const document: ClientSettingsDocument = { version: 1, app: { ...entries } };
        await write(document);
        return document;
      });
    },
  };
}
