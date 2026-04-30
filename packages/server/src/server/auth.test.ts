import { describe, expect, test } from "vitest";

import {
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  isBearerTokenValid,
} from "./auth.js";

describe("daemon bearer validator", () => {
  test("allows any token when no password is configured", () => {
    expect(isBearerTokenValid({ password: undefined, token: null })).toBe(true);
    expect(isBearerTokenValid({ password: undefined, token: "anything" })).toBe(true);
  });

  test("accepts the exact password and rejects missing or wrong tokens", () => {
    expect(isBearerTokenValid({ password: "secret", token: "secret" })).toBe(true);
    expect(isBearerTokenValid({ password: "secret", token: null })).toBe(false);
    expect(isBearerTokenValid({ password: "secret", token: "wrong" })).toBe(false);
  });

  test("extracts HTTP bearer tokens", () => {
    expect(extractHttpBearerToken("Bearer secret")).toBe("secret");
    expect(extractHttpBearerToken("Basic secret")).toBeNull();
    expect(extractHttpBearerToken(undefined)).toBeNull();
  });

  test("extracts WebSocket paseo bearer subprotocol tokens", () => {
    const protocol = extractWsBearerProtocol("chat, paseo.bearer.secret.with.dots");

    expect(protocol).toBe("paseo.bearer.secret.with.dots");
    expect(extractWsBearerToken(protocol)).toBe("secret.with.dots");
    expect(extractWsBearerToken("paseo.other.secret")).toBeNull();
  });
});
