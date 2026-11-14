export interface TerminalResizeRequest {
  rows: number;
  cols: number;
  shouldClaim: boolean;
  forceClaim?: boolean;
}

export function createTerminalResizeDebouncer(input: {
  /** A function is read on every schedule, so a pinch can hold resizes longer while it runs. */
  delayMs: number | (() => number);
  emit: (resize: TerminalResizeRequest) => void;
}): {
  schedule: (resize: TerminalResizeRequest) => void;
  /** Sends a pending resize now. */
  flush: () => void;
  cancel: () => void;
} {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let pending: TerminalResizeRequest | null = null;

  const cancel = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    pending = null;
  };

  const emitPending = () => {
    timeout = null;
    const resizeToEmit = pending;
    pending = null;
    if (resizeToEmit) {
      input.emit(resizeToEmit);
    }
  };

  return {
    schedule: (resize) => {
      pending = {
        ...resize,
        shouldClaim: (pending?.shouldClaim ?? false) || resize.shouldClaim,
        forceClaim: (pending?.forceClaim ?? false) || resize.forceClaim || undefined,
      };
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      const delayMs = typeof input.delayMs === "function" ? input.delayMs() : input.delayMs;
      timeout = setTimeout(emitPending, delayMs);
    },
    flush: () => {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      emitPending();
    },
    cancel,
  };
}
