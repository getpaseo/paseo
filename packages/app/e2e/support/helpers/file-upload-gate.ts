import type { Page, WebSocketRoute } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

function isFileUploadResponse(message: WebSocketMessage): boolean {
  if (typeof message !== "string") return false;
  try {
    const envelope = JSON.parse(message) as { type?: unknown; message?: { type?: unknown } };
    return (envelope.message ?? envelope).type === "file.upload.response";
  } catch {
    return false;
  }
}

/**
 * Holds the daemon's first `file.upload.response`, so the upload is stored on
 * the host but the app still sees it in flight.
 */
export async function holdFileUploadResponse(page: Page) {
  let held: { browser: WebSocketRoute; message: WebSocketMessage } | null = null;
  let resolveHeld: (() => void) | null = null;
  const heldResponse = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (held || !isFileUploadResponse(message)) {
        browser.send(message);
        return;
      }
      held = { browser, message };
      resolveHeld?.();
    });
  });
  return {
    waitUntilHeld: () => heldResponse,
    release: () => held?.browser.send(held.message),
    /** Drops the app's connection while the upload is in flight. */
    disconnect: () => held?.browser.close({ code: 1001, reason: "Upload gate disconnect" }),
  };
}
