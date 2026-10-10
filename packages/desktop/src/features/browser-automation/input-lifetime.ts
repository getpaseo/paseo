import type { TabContents } from "./service.js";

// Keep the command within the daemon broker's existing 15-second input budget.
const INPUT_TIMEOUT_MS = 15_000;

export type TrustedInputPage = Pick<
  TabContents,
  "getURL" | "executeJavaScript" | "sendDebugCommand" | "insertText" | "sendInputEvent"
>;

export class BrowserInputTimeoutError extends Error {
  public constructor() {
    super("Browser input timed out. Input may already have been delivered.");
    this.name = "BrowserInputTimeoutError";
  }
}

interface InputLifetime {
  page: TrustedInputPage;
  signal: AbortSignal;
  assertActive(): void;
  wait<T>(task: () => Promise<T>): Promise<T>;
  dispose(): void;
}

/** Bound renderer and CDP waits without detaching another operation's debugger.
 * Timed-out commands never start queued input or continue a gesture, except
 * releasing its possibly held pointer.
 * Already-dispatched Electron requests cannot be recalled; their outcome is unknown.
 */
export function createInputLifetime(contents: TabContents): InputLifetime {
  const sendDebugCommand = contents.sendDebugCommand;
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = Date.now() + INPUT_TIMEOUT_MS;
  const timeout = setTimeout(
    () => controller.abort(new BrowserInputTimeoutError()),
    INPUT_TIMEOUT_MS,
  );

  function assertActive(): void {
    // Queue continuations can run between expired timers. Check the clock too,
    // so an expired waiter cannot start input before its abort timer is serviced.
    if (Date.now() >= deadline && !signal.aborted) {
      controller.abort(new BrowserInputTimeoutError());
    }
    signal.throwIfAborted();
  }

  function wait<T>(task: () => Promise<T>): Promise<T> {
    assertActive();
    return waitForInput(signal, () => {
      assertActive();
      return task();
    });
  }

  const page: TrustedInputPage = {
    getURL: () => contents.getURL(),
    executeJavaScript: (code) => wait(() => contents.executeJavaScript(code)),
    insertText: (text) => wait(() => contents.insertText(text)),
    sendInputEvent: (event) => {
      assertActive();
      contents.sendInputEvent(event);
    },
  };
  if (sendDebugCommand) {
    page.sendDebugCommand = (command, params) => {
      const releasesPointer =
        command === "Input.dispatchMouseEvent" && params?.type === "mouseReleased";
      // Release a possibly held pointer after cancellation. This cleans up the
      // original gesture without repeating a press or waiting on its acknowledgment.
      if (signal.aborted && releasesPointer) {
        return sendDebugCommand.call(contents, command, params, signal);
      }
      return wait(() => sendDebugCommand.call(contents, command, params, signal));
    };
  }

  return {
    signal,
    assertActive,
    page,
    wait,
    dispose() {
      clearTimeout(timeout);
      // Fence unfinished continuations even when a shorter actionability/paint
      // deadline settled the command before the overall input deadline.
      controller.abort(new BrowserInputTimeoutError());
    },
  };
}

/** Stop waiting at cancellation, while consuming any late rejection from Electron. */
export function waitForInput<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return task();
    });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        return resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        return reject(error);
      },
    );
  });
}
