import type { TerminalViewportState } from "./headless-terminal-state";
import { nativeTerminalPerformanceNow } from "./terminal-performance";

export const NATIVE_TERMINAL_PARSE_CHUNK_CHARS = 64 * 1024;

const NATIVE_TERMINAL_PARSE_CHUNKS_PER_TURN = 32;

export interface NativeTerminalParseSample {
  durationMs: number;
  parsedChars: number;
  queuedChars: number;
}

export interface NativeTerminalOutputDrain {
  enqueueText(text: string): void;
  restoreText(text: string): void;
  clear(): void;
  flush(): Promise<void>;
  dispose(): void;
  getQueuedChars(): number;
}

export interface NativeTerminalOutputDrainOptions {
  write: (chunk: string) => Promise<void>;
  reset: () => void;
  getViewportState: () => TerminalViewportState | null;
  onPaint: (state: TerminalViewportState) => void;
  onParse?: (sample: NativeTerminalParseSample) => void;
  scheduleWork?: (callback: () => void) => void;
  scheduleFrame?: (callback: () => void) => number;
  cancelFrame?: (frame: number) => void;
  chunkChars?: number;
  chunksPerTurn?: number;
}

function defaultScheduleWork(callback: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }
  setTimeout(callback, 0);
}

function defaultScheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return setTimeout(callback, 16) as unknown as number;
}

function defaultCancelFrame(frame: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(frame);
    return;
  }
  clearTimeout(frame as unknown as ReturnType<typeof setTimeout>);
}

export function createNativeTerminalOutputDrain(
  options: NativeTerminalOutputDrainOptions,
): NativeTerminalOutputDrain {
  const scheduleWork = options.scheduleWork ?? defaultScheduleWork;
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame;
  const chunkChars = options.chunkChars ?? NATIVE_TERMINAL_PARSE_CHUNK_CHARS;
  const chunksPerTurn = options.chunksPerTurn ?? NATIVE_TERMINAL_PARSE_CHUNKS_PER_TURN;
  const idleWaiters: Array<() => void> = [];
  let pendingText = "";
  let drainScheduled = false;
  let draining = false;
  let disposed = false;
  let paintFrame: number | null = null;
  let generation = 0;
  let resetBeforeNextWrite = false;

  function resolveIdleIfReady(): void {
    if (drainScheduled || draining || pendingText.length > 0) {
      return;
    }
    while (idleWaiters.length > 0) {
      idleWaiters.shift()?.();
    }
  }

  function requestPaint(): void {
    if (disposed || paintFrame !== null) {
      return;
    }
    paintFrame = scheduleFrame(() => {
      paintFrame = null;
      if (disposed) {
        return;
      }
      const state = options.getViewportState();
      if (state) {
        options.onPaint(state);
      }
    });
  }

  function cancelPendingPaint(): void {
    if (paintFrame === null) {
      return;
    }
    cancelFrame(paintFrame);
    paintFrame = null;
  }

  function scheduleDrain(): void {
    if (disposed || drainScheduled || draining) {
      return;
    }
    drainScheduled = true;
    scheduleWork(() => {
      void drainPending();
    });
  }

  async function drainPending(): Promise<void> {
    if (disposed || draining) {
      return;
    }
    drainScheduled = false;
    draining = true;
    const activeGeneration = generation;
    let parsedChunks = 0;

    try {
      while (pendingText.length > 0 && parsedChunks < chunksPerTurn) {
        if (disposed || activeGeneration !== generation) {
          return;
        }
        if (resetBeforeNextWrite) {
          options.reset();
          resetBeforeNextWrite = false;
        }
        const chunk = pendingText.slice(0, chunkChars);
        pendingText = pendingText.slice(chunk.length);
        const parseStart = nativeTerminalPerformanceNow();
        await options.write(chunk);
        if (disposed || activeGeneration !== generation) {
          return;
        }
        options.onParse?.({
          durationMs: nativeTerminalPerformanceNow() - parseStart,
          parsedChars: chunk.length,
          queuedChars: pendingText.length,
        });
        requestPaint();
        parsedChunks += 1;
      }
    } finally {
      draining = false;
      if (!disposed && pendingText.length > 0) {
        scheduleDrain();
      }
      resolveIdleIfReady();
    }
  }

  return {
    enqueueText(text: string): void {
      if (disposed || text.length === 0) {
        return;
      }
      pendingText += text;
      scheduleDrain();
    },

    restoreText(text: string): void {
      if (disposed) {
        return;
      }
      generation += 1;
      pendingText = text;
      resetBeforeNextWrite = true;
      cancelPendingPaint();
      scheduleDrain();
      resolveIdleIfReady();
    },

    clear(): void {
      generation += 1;
      pendingText = "";
      resetBeforeNextWrite = false;
      cancelPendingPaint();
      resolveIdleIfReady();
    },

    flush(): Promise<void> {
      if (!drainScheduled && !draining && pendingText.length === 0) {
        return Promise.resolve();
      }
      scheduleDrain();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    dispose(): void {
      disposed = true;
      generation += 1;
      pendingText = "";
      resetBeforeNextWrite = false;
      cancelPendingPaint();
      while (idleWaiters.length > 0) {
        idleWaiters.shift()?.();
      }
    },

    getQueuedChars(): number {
      return pendingText.length;
    },
  };
}
