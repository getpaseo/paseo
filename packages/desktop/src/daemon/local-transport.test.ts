import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

const send = vi.fn();

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send } }],
  },
}));

import { closeAllTransportSessions, openWebSocketTransportSession } from "./local-transport";

afterEach(() => {
  closeAllTransportSessions();
  send.mockReset();
});

describe("desktop WebSocket transport", () => {
  it("attaches custom headers when opening a remote daemon session", async () => {
    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    const requestHeaders = new Promise<Record<string, string | string[] | undefined>>((resolve) => {
      webSocketServer.once("connection", (_socket, request) => resolve(request.headers));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP test server address.");
    }

    try {
      const sessionId = await openWebSocketTransportSession({
        transportType: "websocket",
        url: `ws://127.0.0.1:${address.port}/ws`,
        headers: { "X-Tenant": "acme" },
      });

      expect((await requestHeaders)["x-tenant"]).toBe("acme");
      expect(sessionId).toMatch(/^local-session-/);
    } finally {
      closeAllTransportSessions();
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => (error ? reject(error) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("rejects non-WebSocket URLs", () => {
    expect(() =>
      openWebSocketTransportSession({
        transportType: "websocket",
        url: "https://daemon.example/ws",
      }),
    ).toThrow("Unsupported WebSocket transport URL");
  });

  it("rejects malformed custom headers before opening a session", () => {
    expect(() =>
      openWebSocketTransportSession({
        transportType: "websocket",
        url: "ws://daemon.example/ws",
        headers: { "Bad Header": "value" },
      }),
    ).toThrow("Invalid WebSocket transport header");

    expect(() =>
      openWebSocketTransportSession({
        transportType: "websocket",
        url: "ws://daemon.example/ws",
        headers: { "X-Tenant": "acme\r\nX-Injected: true" },
      }),
    ).toThrow("Invalid WebSocket transport header");
  });
});
