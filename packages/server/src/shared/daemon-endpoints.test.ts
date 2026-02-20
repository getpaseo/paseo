import { describe, expect, test } from "vitest";

import {
  buildRelayWebSocketUrl,
  CURRENT_RELAY_PROTOCOL_VERSION,
  normalizeRelayProtocolVersion,
} from "./daemon-endpoints.js";

describe("relay websocket URL versioning", () => {
  test("defaults relay URLs to v2", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        serverId: "srv_test",
        role: "client",
        clientSessionKey: "clsk_test",
      })
    );

    expect(url.searchParams.get("v")).toBe(CURRENT_RELAY_PROTOCOL_VERSION);
    expect(url.searchParams.get("clientId")).toBe("clsk_test");
  });

  test("allows explicitly requesting v1 relay URLs", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        serverId: "srv_test",
        role: "server",
        version: "1",
      })
    );

    expect(url.searchParams.get("v")).toBe("1");
  });

  test("normalizes numeric relay versions", () => {
    expect(normalizeRelayProtocolVersion(2)).toBe("2");
    expect(normalizeRelayProtocolVersion(1)).toBe("1");
  });

  test("rejects unsupported relay versions", () => {
    expect(() => normalizeRelayProtocolVersion("3")).toThrow(
      'Relay version must be "1" or "2"'
    );
  });
});
