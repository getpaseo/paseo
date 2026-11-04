import type { Page, WebSocketRoute } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

function listingResponse(message: string | Buffer) {
  try {
    const envelope = JSON.parse(message.toString());
    return envelope.message?.type === "file_explorer_response" ? envelope.message.payload : null;
  } catch {
    return null;
  }
}

/** Delay one real directory response after the daemon has read its contents. */
export async function delayDirectoryListingResponse(page: Page, directoryPath: string) {
  let held: { socket: WebSocketRoute; message: string | Buffer; requestId: string } | null = null;
  let resolveHeld!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const response = listingResponse(message);
      if (!held && response?.mode === "list" && response.path === directoryPath) {
        held = { socket, message, requestId: response.requestId };
        resolveHeld();
        return;
      }
      socket.send(message);
    });
  });
  return {
    waitUntilHeld: () => heldResponse,
    release: async () => {
      if (!held) throw new Error("Directory response must be held before release");
      held.socket.send(held.message);
      // Let the delivered reply update the UI before the user reopens the folder.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    },
  };
}
