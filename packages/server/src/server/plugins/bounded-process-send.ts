export const PLUGIN_PROCESS_SEND_TIMEOUT_MS = 1_000;

type ProcessSendCallback = (error?: Error | null) => void;

/**
 * Child-process IPC callbacks are not guaranteed to run when the peer is
 * wedged. Every caller must get a finite settlement so lifecycle cleanup can
 * take the kill path.
 */
export function sendPluginProcessMessage<T>(
  sender: ((message: T, callback: ProcessSendCallback) => boolean) | undefined,
  message: T,
  timeoutMs = PLUGIN_PROCESS_SEND_TIMEOUT_MS,
  onSettled?: ProcessSendCallback,
): Promise<void> {
  if (!sender) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`Plugin process IPC send timed out after ${timeoutMs}ms`);
      onSettled?.(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();

    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      onSettled?.(error);
      if (error) reject(error);
      else resolve();
    };

    try {
      sender(message, settle);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
