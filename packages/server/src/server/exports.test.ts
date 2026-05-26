import { createPaseoClient } from "@getpaseo/client";
import {
  DaemonClient,
  type ConnectionState,
  type DaemonClientConfig,
  type DaemonEvent,
  type WebSocketFactory,
  type WebSocketLike,
} from "@getpaseo/server";
import { expect, test } from "vitest";

test("keeps legacy daemon client exports on the server package", () => {
  const config: DaemonClientConfig = {
    url: "ws://127.0.0.1:6767/ws",
    clientId: "legacy-export-test",
  };
  const state: ConnectionState = { status: "idle" };
  const event: DaemonEvent = { type: "error", message: "boom" };
  const socket: WebSocketLike = {
    readyState: 0,
    send: () => {},
    close: () => {},
  };
  const webSocketFactory: WebSocketFactory = () => socket;

  expect(DaemonClient).toBeTypeOf("function");
  expect(createPaseoClient).toBeTypeOf("function");
  expect(config.clientId).toBe("legacy-export-test");
  expect(state.status).toBe("idle");
  expect(event.message).toBe("boom");
  expect(webSocketFactory("ws://127.0.0.1:6767/ws")).toBe(socket);
});
