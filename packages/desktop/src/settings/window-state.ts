import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const MIN_WINDOW_WIDTH = 400;
export const MIN_WINDOW_HEIGHT = 300;

// Smallest slice of the window that must remain on a display for the saved
// position to count as "still reachable" after the monitor layout changes.
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 80;

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

/** A display's usable area (excludes the menu bar / taskbar), in DIP coordinates. */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PersistedWindowStateDocument {
  version: 1;
  state: WindowState;
}

export interface WindowStateStore {
  /** Returns the persisted state, or null when nothing usable is stored. */
  load(): Promise<WindowState | null>;
  /** Persists the state atomically off the main thread (serialized writes). */
  save(state: WindowState): Promise<void>;
  /** Persists the state synchronously — used as the final writer on close/quit. */
  saveSync(state: WindowState): void;
}

const WINDOW_STATE_FILENAME = "window-state.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function coerceFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function coerceDimension(value: unknown, minimum: number): number | null {
  const rounded = coerceFiniteNumber(value);
  if (rounded === null) {
    return null;
  }
  return Math.max(minimum, rounded);
}

export function coerceWindowState(input: unknown): WindowState | null {
  if (!isRecord(input)) {
    return null;
  }

  const width = coerceDimension(input.width, MIN_WINDOW_WIDTH);
  const height = coerceDimension(input.height, MIN_WINDOW_HEIGHT);
  if (width === null || height === null) {
    return null;
  }

  const state: WindowState = { width, height, isMaximized: input.isMaximized === true };

  const x = coerceFiniteNumber(input.x);
  const y = coerceFiniteNumber(input.y);
  // Only trust a position when both coordinates are present; a half-known
  // position is worse than letting the OS place the window.
  if (x !== null && y !== null) {
    state.x = x;
    state.y = y;
  }

  return state;
}

function serializeDocument(state: WindowState): string {
  const document: PersistedWindowStateDocument = { version: 1, state };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Adjust a saved window state to the current display layout so the window never
 * opens off-screen. Drops the saved position when it would not be reachable on
 * any connected display, and shrinks oversized windows to the target work area.
 * Pure: the caller supplies the display work areas (from Electron's `screen`).
 */
export function clampWindowStateToWorkAreas(
  state: WindowState,
  workAreas: WorkArea[],
): WindowState {
  const primary = workAreas[0];
  if (!primary) {
    // No display info — keep the size, let the OS place the window.
    return { width: state.width, height: state.height, isMaximized: state.isMaximized };
  }

  let target: WorkArea = primary;
  const { x, y } = state;
  let positioned = false;

  if (x !== undefined && y !== undefined) {
    const requiredWidth = Math.min(MIN_VISIBLE_WIDTH, state.width);
    const requiredHeight = Math.min(MIN_VISIBLE_HEIGHT, state.height);
    let bestOverlap = 0;

    for (const workArea of workAreas) {
      const overlapWidth = Math.max(
        0,
        Math.min(x + state.width, workArea.x + workArea.width) - Math.max(x, workArea.x),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(y + state.height, workArea.y + workArea.height) - Math.max(y, workArea.y),
      );
      const overlap = overlapWidth * overlapHeight;
      const isVisibleEnough = overlapWidth >= requiredWidth && overlapHeight >= requiredHeight;
      if (isVisibleEnough && overlap > bestOverlap) {
        bestOverlap = overlap;
        target = workArea;
        positioned = true;
      }
    }
  }

  const width = Math.min(Math.max(state.width, MIN_WINDOW_WIDTH), target.width);
  const height = Math.min(Math.max(state.height, MIN_WINDOW_HEIGHT), target.height);

  if (positioned && x !== undefined && y !== undefined) {
    // Keep the window inside the chosen display after the size clamp so an
    // oversized saved state cannot end up mostly off-screen.
    const clampedX = Math.min(Math.max(x, target.x), target.x + target.width - width);
    const clampedY = Math.min(Math.max(y, target.y), target.y + target.height - height);
    return { x: clampedX, y: clampedY, width, height, isMaximized: state.isMaximized };
  }
  return { width, height, isMaximized: state.isMaximized };
}

export function createWindowStateStore({
  userDataPath,
}: {
  userDataPath: string;
}): WindowStateStore {
  const filePath = path.join(userDataPath, WINDOW_STATE_FILENAME);
  let persistQueue: Promise<void> = Promise.resolve();
  // Once the synchronous final write lands (on close/quit), pending async
  // writes must not clobber it with an older snapshot.
  let finalized = false;

  function tempFilePath(): string {
    return `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  }

  return {
    async load(): Promise<WindowState | null> {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        // No file yet (first launch) is expected; surface anything else.
        if (isNodeError(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        // A corrupted file shouldn't block launch; non-critical state falls back.
        if (error instanceof SyntaxError) {
          return null;
        }
        throw error;
      }

      if (!isRecord(parsed)) {
        return null;
      }
      return coerceWindowState(parsed.state);
    },

    async save(state: WindowState): Promise<void> {
      const contents = serializeDocument(state);
      async function write(): Promise<void> {
        if (finalized) {
          return;
        }
        await mkdir(userDataPath, { recursive: true });
        const tempPath = tempFilePath();
        await writeFile(tempPath, contents, "utf8");
        if (finalized) {
          // A synchronous final write (saveSync) landed while this one was in
          // flight. Keep it as the last writer instead of overwriting it, and
          // discard our now-stale temp file so it can't accumulate in userData.
          await unlink(tempPath).catch(() => undefined);
          return;
        }
        await rename(tempPath, filePath);
      }
      const queued = persistQueue.then(write, write);
      persistQueue = queued.catch(() => undefined);
      await queued;
    },

    saveSync(state: WindowState): void {
      finalized = true;
      const contents = serializeDocument(state);
      mkdirSync(userDataPath, { recursive: true });
      const tempPath = tempFilePath();
      writeFileSync(tempPath, contents, "utf8");
      renameSync(tempPath, filePath);
    },
  };
}
