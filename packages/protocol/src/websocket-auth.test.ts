import { describe, expect, test } from "vitest";

import { decodeWebSocketBearerProtocol, encodeWebSocketBearerProtocol } from "./websocket-auth.js";

describe("WebSocket bearer protocol", () => {
  test("preserves the legacy protocol for token-safe passwords", () => {
    const protocol = encodeWebSocketBearerProtocol("secret.with-dots");

    expect(protocol).toBe("paseo.bearer.secret.with-dots");
    expect(decodeWebSocketBearerProtocol(protocol)).toBe("secret.with-dots");
  });

  test("round-trips passwords containing non-token characters", () => {
    const protocol = encodeWebSocketBearerProtocol("base64+/= 🔐");

    expect(protocol).toBe("paseo.bearer64.YmFzZTY0Ky89IPCflJA");
    expect(decodeWebSocketBearerProtocol(protocol)).toBe("base64+/= 🔐");
  });

  test("rejects malformed and unrelated protocols", () => {
    expect(decodeWebSocketBearerProtocol("paseo.bearer64.not+base64url")).toBeNull();
    expect(decodeWebSocketBearerProtocol("paseo.bearer64.a")).toBeNull();
    expect(decodeWebSocketBearerProtocol("paseo.other.secret")).toBeNull();
  });
});
