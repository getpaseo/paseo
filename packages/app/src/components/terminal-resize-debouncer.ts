export interface TerminalResizeRequest {
  rows: number;
  cols: number;
  shouldClaim: boolean;
  forceClaim?: boolean;
}

export function createTerminalResizeDebouncer(input: {
  delayMs: number;
  emit: (resize: TerminalResizeRequest) => void;
}): {
  schedule: (resize: TerminalResizeRequest) => void;
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
      timeout = setTimeout(() => {
        timeout = null;
        const resizeToEmit = pending;
        pending = null;
        if (resizeToEmit) {
          input.emit(resizeToEmit);
        }
      }, input.delayMs);
    },
    cancel,
  };
}
