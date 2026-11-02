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
  replay(event: import("@getpaseo/client").TerminalReplayEvent): void;
  enqueueText(text: string): void;
  resize(): void;
  clear(): void;
  flush(): Promise<void>;
  dispose(): void;
  getQueuedChars(): number;
}

export interface NativeTerminalOutputDrainOptions {
  write: (chunk: string) => Promise<void>;
  restoreSize: () => void;
  reset: (size?: { rows: number; cols: number }) => void;
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
  type Operation =
    | { type: "write"; text: string }
    | { type: "reset"; size?: { rows: number; cols: number } }
    | { type: "restore-size" };
  let operations: Operation[] = [];
  let queuedChars = 0;
  let drainScheduled = false;
  let draining = false;
  let disposed = false;
  let replaying = false;
  let paintFrame: number | null = null;
  let generation = 0;
  const replayDecoder = new TextDecoder();

  function resolveIdleIfReady(): void {
    if (drainScheduled || draining || operations.length > 0) {
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
      while (operations.length > 0 && parsedChunks < chunksPerTurn) {
        if (disposed || activeGeneration !== generation) return;
        const operation = operations[0]!;
        if (operation.type !== "write") {
          operations.shift();
          if (operation.type === "reset") options.reset(operation.size);
          else {
            options.restoreSize();
            replaying = false;
          }
          requestPaint();
          continue;
        }
        const chunk = operation.text.slice(0, chunkChars);
        operation.text = operation.text.slice(chunk.length);
        queuedChars -= chunk.length;
        if (!operation.text) operations.shift();
        const parseStart = nativeTerminalPerformanceNow();
        await options.write(chunk);
        if (disposed || activeGeneration !== generation) {
          return;
        }
        options.onParse?.({
          durationMs: nativeTerminalPerformanceNow() - parseStart,
          parsedChars: chunk.length,
          queuedChars,
        });
        requestPaint();
        parsedChunks += 1;
      }
    } finally {
      draining = false;
      if (!disposed && operations.length > 0) {
        scheduleDrain();
      }
      resolveIdleIfReady();
    }
  }

  return {
    replay(event): void {
      if (disposed) return;
      if (event.type === "begin") {
        replaying = true;
        generation++;
        replayDecoder.decode();
        operations = [
          {
            type: "reset",
            size: event.rows && event.cols ? { rows: event.rows, cols: event.cols } : undefined,
          },
        ];
        queuedChars = 0;
        cancelPendingPaint();
      } else if (event.type === "data") {
        this.enqueueText(replayDecoder.decode(event.data, { stream: true }));
      } else {
        this.enqueueText(replayDecoder.decode());
        operations.push({ type: "restore-size" });
      }
      scheduleDrain();
    },
    enqueueText(text: string): void {
      if (disposed || !text) return;
      const last = operations.at(-1);
      if (last?.type === "write") last.text += text;
      else operations.push({ type: "write", text });
      queuedChars += text.length;
      scheduleDrain();
    },

    resize(): void {
      if (disposed || replaying) return;
      operations.push({ type: "restore-size" });
      scheduleDrain();
    },

    clear(): void {
      if (disposed) return;
      generation += 1;
      operations = [{ type: "restore-size" }, { type: "reset" }];
      queuedChars = 0;
      replayDecoder.decode();
      cancelPendingPaint();
      scheduleDrain();
      resolveIdleIfReady();
    },

    flush(): Promise<void> {
      if (!drainScheduled && !draining && operations.length === 0) {
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
      operations = [];
      queuedChars = 0;
      cancelPendingPaint();
      while (idleWaiters.length > 0) {
        idleWaiters.shift()?.();
      }
    },

    getQueuedChars(): number {
      return queuedChars;
    },
  };
}
