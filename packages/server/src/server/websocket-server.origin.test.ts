import { describe, expect, test } from "vitest";

import { isWebSocketSameOrigin } from "./websocket-server.js";

describe("isWebSocketSameOrigin", () => {
  test("accepts exact same-origin websocket upgrades", () => {
    expect(isWebSocketSameOrigin("http://localhost:6767", "localhost:6767")).toBe(true);
    expect(isWebSocketSameOrigin("https://paseo.example.com", "paseo.example.com")).toBe(true);
  });

  test("accepts loopback aliases on the same port", () => {
    expect(isWebSocketSameOrigin("http://127.0.0.1:32775", "localhost:32775")).toBe(true);
    expect(isWebSocketSameOrigin("http://localhost:32775", "127.0.0.1:32775")).toBe(true);
    expect(isWebSocketSameOrigin("http://[::1]:32775", "localhost:32775")).toBe(true);
  });

  test("rejects loopback aliases on different ports", () => {
    expect(isWebSocketSameOrigin("http://127.0.0.1:32775", "localhost:6767")).toBe(false);
  });

  test("rejects non-loopback cross-origin upgrades", () => {
    expect(isWebSocketSameOrigin("http://evil.example:32775", "localhost:32775")).toBe(false);
    expect(isWebSocketSameOrigin("http://127.0.0.1:32775", "paseo.example.com:32775")).toBe(false);
  });
});
