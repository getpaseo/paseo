import type { Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

function fileReadRequest(message: WebSocketMessage, path: string): boolean {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { type?: unknown; message?: unknown };
    const session =
      envelope.type === "session" && envelope.message && typeof envelope.message === "object"
        ? (envelope.message as { type?: unknown; mode?: unknown; path?: unknown })
        : (envelope as { type?: unknown; mode?: unknown; path?: unknown });
    return (
      session.type === "file_explorer_request" && session.mode === "file" && session.path === path
    );
  } catch {
    return false;
  }
}

export async function delayFileReadResponse(page: Page, path: string) {
  let delayed: (() => void) | null = null;
  let resolveDelayed: (() => void) | null = null;
  const delayedResponse = new Promise<void>((resolve) => {
    resolveDelayed = resolve;
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      ws.send(message);
    });
    // Hold the outgoing JSON request. The corresponding body response travels as
    // binary frames, so intercepting the response cannot identify this read.
    ws.onMessage((message) => {
      if (delayed || !fileReadRequest(message, path)) {
        server.send(message);
        return;
      }
      delayed = () => server.send(message);
      resolveDelayed?.();
    });
  });
  return {
    waitUntilHeld: () => delayedResponse,
    release: () => delayed?.(),
  };
}
