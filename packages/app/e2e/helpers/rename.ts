import { type Page } from "@playwright/test";

/**
 * Listens for outbound WebSocket "session" frames of a given inner message type
 * and accumulates them. The returned array is populated in-place as frames arrive.
 */
export function captureWsSessionFrames<T extends Record<string, unknown>>(
  page: Page,
  messageType: string,
  extract: (inner: Record<string, unknown>) => T,
): T[] {
  const captured: T[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const raw = frame.payload;
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      try {
        const outer = JSON.parse(text) as { type?: string; message?: Record<string, unknown> };
        if (outer.type === "session" && outer.message?.type === messageType) {
          captured.push(extract(outer.message));
        }
      } catch {
        // Ignore non-JSON and binary frames.
      }
    });
  });
  return captured;
}

export function renameModalInput(page: Page, testIdPrefix: string) {
  return page.getByTestId(`${testIdPrefix}-input`);
}

export function renameModalSubmit(page: Page, testIdPrefix: string) {
  return page.getByTestId(`${testIdPrefix}-submit`);
}

export function renameModalError(page: Page, testIdPrefix: string) {
  return page.getByTestId(`${testIdPrefix}-error`);
}
