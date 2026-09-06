import { describe, expect, test } from "vitest";
import {
  createWebSocketFactories,
  type WebSocketConstructor,
} from "./daemon-client-websocket-transport.js";

type ConstructorArgs = [string, (string | string[])?, { headers?: Record<string, string> }?];

function createFakeWebSocketConstructor(): {
  FakeWebSocket: WebSocketConstructor;
  calls: ConstructorArgs[];
} {
  const calls: ConstructorArgs[] = [];
  class FakeWebSocket {
    readyState = 0;
    constructor(...args: ConstructorArgs) {
      calls.push(args);
    }
    send(): void {}
    close(): void {}
  }
  return { FakeWebSocket, calls };
}

describe("daemon-client WebSocket factories", () => {
  test("nativeWebSocketFactory forwards handshake headers as the React Native options argument", () => {
    const { FakeWebSocket, calls } = createFakeWebSocketConstructor();
    const { nativeWebSocketFactory } = createWebSocketFactories(() => FakeWebSocket);

    nativeWebSocketFactory("ws://example.test/ws", {
      protocols: ["paseo.bearer.secret"],
      headers: { "CF-Access-Client-Id": "token-id.access" },
    });

    expect(calls).toEqual([
      [
        "ws://example.test/ws",
        ["paseo.bearer.secret"],
        { headers: { "CF-Access-Client-Id": "token-id.access" } },
      ],
    ]);
  });

  test("defaultWebSocketFactory keeps the browser two-argument constructor and drops headers", () => {
    const { FakeWebSocket, calls } = createFakeWebSocketConstructor();
    const { defaultWebSocketFactory } = createWebSocketFactories(() => FakeWebSocket);

    defaultWebSocketFactory("ws://example.test/ws", {
      protocols: ["paseo.bearer.secret"],
      headers: { "CF-Access-Client-Id": "token-id.access" },
    });

    expect(calls).toEqual([["ws://example.test/ws", ["paseo.bearer.secret"]]]);
  });

  test("defaultWebSocketFactory omits the protocols argument when none are given", () => {
    const { FakeWebSocket, calls } = createFakeWebSocketConstructor();
    const { defaultWebSocketFactory } = createWebSocketFactories(() => FakeWebSocket);

    defaultWebSocketFactory("ws://example.test/ws");

    expect(calls).toEqual([["ws://example.test/ws"]]);
  });
});
