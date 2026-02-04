type FocusWithRetriesOptions = {
  focus: () => void;
  isFocused: () => boolean;
  timeoutMs?: number;
  onSuccess?: () => void;
  onTimeout?: () => void;
};

export function focusWithRetries({
  focus,
  isFocused,
  timeoutMs = 1500,
  onSuccess,
  onTimeout,
}: FocusWithRetriesOptions): () => void {
  let cancelled = false;
  const deadlineMs = Date.now() + timeoutMs;

  const tick = () => {
    if (cancelled) return;

    try {
      focus();
    } catch {
      // ignore
    }

    if (isFocused()) {
      onSuccess?.();
      return;
    }

    if (Date.now() >= deadlineMs) {
      onTimeout?.();
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(tick);
    });
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(tick);
  });

  return () => {
    cancelled = true;
  };
}

