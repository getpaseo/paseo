import { describe, expect, test } from "vitest";

import { hashDaemonPassword } from "./auth.js";
import {
  isCrossOriginUpgradePasswordAuthorized,
  isWebSocketSameOrigin,
} from "./websocket-server.js";

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

describe("isCrossOriginUpgradePasswordAuthorized", () => {
  const passwordHash = hashDaemonPassword("secret");

  test("accepts a cross-origin upgrade carrying the correct daemon password", () => {
    expect(isCrossOriginUpgradePasswordAuthorized(passwordHash, "paseo.bearer.secret")).toBe(true);
  });

  test("rejects a wrong or missing bearer token", () => {
    expect(isCrossOriginUpgradePasswordAuthorized(passwordHash, "paseo.bearer.wrong")).toBe(false);
    expect(isCrossOriginUpgradePasswordAuthorized(passwordHash, undefined)).toBe(false);
    expect(isCrossOriginUpgradePasswordAuthorized(passwordHash, "some.other.protocol")).toBe(false);
  });

  test("never authorizes cross-origin when no daemon password is configured", () => {
    expect(isCrossOriginUpgradePasswordAuthorized(undefined, "paseo.bearer.secret")).toBe(false);
  });
});
