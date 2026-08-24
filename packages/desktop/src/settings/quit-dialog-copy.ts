import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Localized strings for the quit confirmation dialog.
 *
 * The main process has no i18n bundle, but the quit prompt is the most-seen new
 * string in an app that ships every locale under `app/src/i18n/resources`, so an
 * English-only dialog is not acceptable. The renderer owns translation and pushes
 * the resolved strings here;
 * main keeps them in memory and mirrors them to disk so the very first quit after
 * a cold start is already localized.
 *
 * Kept out of DesktopSettings on purpose: five display strings would otherwise
 * cost five hand-written coercion points in the desktop schema and five more in
 * the renderer mirror, for data that is a cache rather than a preference.
 */
export interface QuitDialogCopy {
  title: string;
  message: string;
  quitLabel: string;
  cancelLabel: string;
  keepDaemonRunningLabel: string;
}

export const DEFAULT_QUIT_DIALOG_COPY: QuitDialogCopy = {
  title: "Quit Paseo?",
  message:
    "Quitting stops the local daemon, along with any agents it is running. Their work will be interrupted.",
  quitLabel: "Quit",
  cancelLabel: "Cancel",
  keepDaemonRunningLabel: "Leave the daemon running",
};

const QUIT_DIALOG_COPY_FILENAME = "quit-dialog-copy.json";

interface PersistedQuitDialogCopyDocument {
  version: 1;
  copy: QuitDialogCopy;
}

export interface QuitDialogCopyStore {
  /** Synchronous: the quit path must never wait on disk. */
  get(): QuitDialogCopy;
  /** Reads the mirrored copy from disk. Safe to call once at startup. */
  load(): Promise<void>;
  /** Accepts freshly translated copy from the renderer and mirrors it to disk. */
  set(input: unknown): Promise<QuitDialogCopy>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Falls back per key, not wholesale: a locale file that is missing one string
 * should still get the other four translated rather than reverting the whole
 * dialog to English.
 */
export function coerceQuitDialogCopy(input: unknown): QuitDialogCopy {
  const record = isRecord(input) ? input : {};
  return {
    title: coerceString(record.title) ?? DEFAULT_QUIT_DIALOG_COPY.title,
    message: coerceString(record.message) ?? DEFAULT_QUIT_DIALOG_COPY.message,
    quitLabel: coerceString(record.quitLabel) ?? DEFAULT_QUIT_DIALOG_COPY.quitLabel,
    cancelLabel: coerceString(record.cancelLabel) ?? DEFAULT_QUIT_DIALOG_COPY.cancelLabel,
    keepDaemonRunningLabel:
      coerceString(record.keepDaemonRunningLabel) ??
      DEFAULT_QUIT_DIALOG_COPY.keepDaemonRunningLabel,
  };
}

export function createQuitDialogCopyStore({
  userDataPath,
}: {
  userDataPath: string;
}): QuitDialogCopyStore {
  const filePath = path.join(userDataPath, QUIT_DIALOG_COPY_FILENAME);
  let copy: QuitDialogCopy = DEFAULT_QUIT_DIALOG_COPY;
  let persistQueue: Promise<void> = Promise.resolve();

  async function persist(next: QuitDialogCopy): Promise<void> {
    const document: PersistedQuitDialogCopyDocument = { version: 1, copy: next };
    const write = async () => {
      await mkdir(userDataPath, { recursive: true });
      const tempFilePath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
      await writeFile(tempFilePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(tempFilePath, filePath);
    };
    const queued = persistQueue.then(write, write);
    persistQueue = queued.catch(() => undefined);
    await queued;
  }

  return {
    get: () => copy,

    async load(): Promise<void> {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        // No mirror yet (first launch) is expected; anything else still must not
        // block startup, so English stands in either way.
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A corrupt mirror is a cache miss, not a failure.
        return;
      }

      copy = coerceQuitDialogCopy(isRecord(parsed) ? parsed.copy : null);
    },

    async set(input: unknown): Promise<QuitDialogCopy> {
      copy = coerceQuitDialogCopy(input);
      await persist(copy);
      return copy;
    },
  };
}
