import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { isNewerVersion } from "./app-update-version.js";

export const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Paces automatic updates so frequent releases stay calm: automatic checks run
 * at most once per interval, and a paced release is deferred for the cooldown
 * after the app last moved to a newer version.
 *
 * Every answer fails open. Missing, damaged, unreadable or unwritable state, a
 * clock that jumped, and any unexpected error all answer "check now" and "not in
 * cooldown". No method rejects.
 */
export interface AppUpdatePacing {
  /** Loads the stored state and notes the running version. Call once at startup. */
  start(): Promise<void>;
  isAutomaticCheckDue(): Promise<boolean>;
  recordAutomaticCheck(): Promise<void>;
  isInUpdateCooldown(): Promise<boolean>;
}

export interface AppUpdatePacingDeps {
  filePath(): string;
  currentVersion(): string;
  now(): number;
  reportError?(error: unknown): void;
}

const TimestampSchema = z.number().finite().nonnegative().nullable().catch(null);

// Loose, so a field added by a newer build survives a launch of this one.
const PacingStateSchema = z.looseObject({
  lastAutoCheckAt: TimestampSchema,
  lastVersionSeen: z.string().min(1).nullable().catch(null),
  lastAutoUpdateAt: TimestampSchema,
});

type PacingState = z.output<typeof PacingStateSchema>;

const EMPTY_STATE: PacingState = {
  lastAutoCheckAt: null,
  lastVersionSeen: null,
  lastAutoUpdateAt: null,
};

/**
 * A window is open only while `now` sits inside it. A timestamp in the future
 * comes from a clock that moved back, and it must not hold the window open
 * until the clock catches up.
 */
function isWithinWindow(startedAt: number | null, now: number, durationMs: number): boolean {
  if (startedAt === null) return false;
  const elapsed = now - startedAt;
  return elapsed >= 0 && elapsed < durationMs;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function createAppUpdatePacing(deps: AppUpdatePacingDeps): AppUpdatePacing {
  // `state` always equals what is on disk. A change that cannot be stored is
  // dropped, so a version advance that fails to persist cannot restart the
  // cooldown on every launch.
  let state: PacingState = EMPTY_STATE;
  let loaded = false;
  let operationQueue: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readState(filePath: string): Promise<PacingState> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) deps.reportError?.(error);
      return EMPTY_STATE;
    }

    try {
      return PacingStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      deps.reportError?.(error);
      return EMPTY_STATE;
    }
  }

  async function store(next: PacingState): Promise<void> {
    const filePath = deps.filePath();
    const tempFilePath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(tempFilePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(tempFilePath, filePath);
      state = next;
    } catch (error) {
      deps.reportError?.(error);
      await rm(tempFilePath, { force: true }).catch(() => undefined);
    }
  }

  async function noteRunningVersion(): Promise<void> {
    const currentVersion = deps.currentVersion();
    const previousVersion = state.lastVersionSeen;
    if (previousVersion === currentVersion) return;

    // `lastVersionSeen` is the newest version this install has run. A launch of
    // an older build leaves it alone, so switching between two installed builds
    // cannot restart the cooldown each time the newer one starts.
    if (previousVersion !== null && isNewerVersion(previousVersion, currentVersion)) return;

    // With no earlier version to compare (first launch, or the first launch of
    // a build that keeps this state), the app did not necessarily update.
    const updated = previousVersion !== null && isNewerVersion(currentVersion, previousVersion);
    await store({
      ...state,
      lastVersionSeen: currentVersion,
      lastAutoUpdateAt: updated ? deps.now() : state.lastAutoUpdateAt,
    });
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    state = await readState(deps.filePath());
    await noteRunningVersion();
    loaded = true;
  }

  function withState<T>(fallback: T, read: () => T | Promise<T>): Promise<T> {
    return enqueue(async () => {
      try {
        await ensureLoaded();
        return await read();
      } catch (error) {
        deps.reportError?.(error);
        return fallback;
      }
    });
  }

  return {
    start: () => withState(undefined, () => undefined),
    isAutomaticCheckDue: () =>
      withState(
        true,
        () => !isWithinWindow(state.lastAutoCheckAt, deps.now(), AUTOMATIC_CHECK_INTERVAL_MS),
      ),
    recordAutomaticCheck: () =>
      withState(undefined, () => store({ ...state, lastAutoCheckAt: deps.now() })),
    isInUpdateCooldown: () =>
      withState(false, () =>
        isWithinWindow(state.lastAutoUpdateAt, deps.now(), UPDATE_COOLDOWN_MS),
      ),
  };
}
