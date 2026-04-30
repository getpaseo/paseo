import { describe, expect, test } from "vitest";

import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  CURRENT_RELAY_PROTOCOL_VERSION,
  normalizeRelayProtocolVersion,
  parseConnectionUri,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
} from "./daemon-endpoints.js";

describe("connection URI parsing", () => {
  test("round-trips a tcp host and port", () => {
    const parsed = parseConnectionUri("tcp://localhost:6767");

    expect(parsed).toEqual({
      host: "localhost",
      port: 6767,
      isIpv6: false,
      useTls: false,
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://localhost:6767");
  });

  test("round-trips an SSL-enabled tcp host and port", () => {
    const parsed = parseConnectionUri("tcp://example.com:443?ssl=true");

    expect(parsed).toEqual({
      host: "example.com",
      port: 443,
      isIpv6: false,
      useTls: true,
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://example.com:443?ssl=true");
  });

  test("round-trips an IPv6 host", () => {
    const parsed = parseConnectionUri("tcp://[::1]:6767?ssl=true");

    expect(parsed).toEqual({
      host: "::1",
      port: 6767,
      isIpv6: true,
      useTls: true,
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://[::1]:6767?ssl=true");
  });

  test("rejects a missing port", () => {
    expect(() => parseConnectionUri("tcp://localhost")).toThrow("Connection URI port is required");
  });

  test("rejects an invalid scheme", () => {
    expect(() => parseConnectionUri("http://localhost:6767")).toThrow(
      "Connection URI protocol must be tcp:",
    );
  });

  test("parses password without including it in the public serializer", () => {
    const parsed = parseConnectionUri("tcp://localhost:6767?ssl=true&password=secret");

    expect(parsed).toEqual({
      host: "localhost",
      port: 6767,
      isIpv6: false,
      useTls: true,
      password: "secret",
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://localhost:6767?ssl=true");
    expect(serializeConnectionUriForStorage(parsed)).toBe(
      "tcp://localhost:6767?ssl=true&password=secret",
    );
  });

  test("rejects userinfo passwords", () => {
    expect(() => parseConnectionUri("tcp://:secret@localhost:6767?ssl=true")).toThrow(
      "Connection URI userinfo is not supported",
    );
  });
});

describe("daemon websocket URLs", () => {
  test("uses ws for port 443 when TLS is disabled", () => {
    expect(buildDaemonWebSocketUrl("example.com:443", { useTls: false })).toBe(
      "ws://example.com:443/ws",
    );
  });

  test("uses wss for non-443 ports when TLS is enabled", () => {
    expect(buildDaemonWebSocketUrl("example.com:6767", { useTls: true })).toBe(
      "wss://example.com:6767/ws",
    );
  });
});

describe("relay websocket URL versioning", () => {
  test("defaults relay URLs to v2", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        useTls: true,
        serverId: "srv_test",
        role: "client",
      }),
    );

    expect(url.searchParams.get("v")).toBe(CURRENT_RELAY_PROTOCOL_VERSION);
    expect(url.searchParams.has("connectionId")).toBe(false);
  });

  test("includes connectionId when provided (server data sockets)", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        useTls: true,
        serverId: "srv_test",
        role: "server",
        connectionId: "conn_abc123",
      }),
    );

    expect(url.searchParams.get("connectionId")).toBe("conn_abc123");
  });

  test("allows explicitly requesting v1 relay URLs", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        useTls: true,
        serverId: "srv_test",
        role: "server",
        version: "1",
      }),
    );

    expect(url.searchParams.get("v")).toBe("1");
  });

  test("normalizes numeric relay versions", () => {
    expect(normalizeRelayProtocolVersion(2)).toBe("2");
    expect(normalizeRelayProtocolVersion(1)).toBe("1");
  });

  test("rejects unsupported relay versions", () => {
    expect(() => normalizeRelayProtocolVersion("3")).toThrow('Relay version must be "1" or "2"');
  });
});

describe("relay websocket URLs", () => {
  test("uses ws for port 443 when TLS is disabled", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        useTls: false,
        serverId: "srv_test",
        role: "client",
      }),
    );

    expect(url.protocol).toBe("ws:");
  });

  test("uses wss for non-443 ports when TLS is enabled", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:6767",
        useTls: true,
        serverId: "srv_test",
        role: "client",
      }),
    );

    expect(url.protocol).toBe("wss:");
  });
});
