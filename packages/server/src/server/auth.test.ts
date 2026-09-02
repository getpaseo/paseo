import { describe, expect, test } from "vitest";

import {
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  hashDaemonPassword,
  isAgentMcpRequestAuthorized,
  isBearerTokenValidAsync,
  isBearerTokenValid,
  isLoopbackConnection,
  isLoopbackPasswordExempt,
  shouldBypassBearerAuth,
} from "./auth.js";

const CORRECT_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

describe("daemon bearer validator", () => {
  test("allows any token when no password is configured", () => {
    expect(isBearerTokenValid({ password: undefined, token: null })).toBe(true);
    expect(isBearerTokenValid({ password: undefined, token: "anything" })).toBe(true);
  });

  test("accepts the plaintext token against the bcrypt hash and rejects missing or wrong tokens", async () => {
    expect(
      await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "correct-password" }),
    ).toBe(true);
    expect(isBearerTokenValid({ password: CORRECT_PASSWORD_HASH, token: "correct-password" })).toBe(
      true,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: null })).toBe(
      false,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "wrong" })).toBe(
      false,
    );
  });

  test("hashes a password into a bcrypt value", () => {
    const hash = hashDaemonPassword("correct-password");

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(isBearerTokenValid({ password: hash, token: "correct-password" })).toBe(true);
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

  test("bypasses bearer auth for preflight, liveness, and capability-token routes", () => {
    // Preflight is always bypassed regardless of path.
    expect(shouldBypassBearerAuth("OPTIONS", "/api/status")).toBe(true);
    // Unauthenticated liveness probe.
    expect(shouldBypassBearerAuth("GET", "/api/health")).toBe(true);
    // Guarded by its own single-use download token, not the daemon password.
    expect(shouldBypassBearerAuth("GET", "/api/files/download")).toBe(true);
    // Guarded by its own per-daemon-run capability token (see
    // isAgentMcpRequestAuthorized), not the daemon password.
    expect(shouldBypassBearerAuth("POST", "/mcp/agents")).toBe(true);
    // Everything else stays behind the daemon password.
    expect(shouldBypassBearerAuth("GET", "/api/status")).toBe(false);
    expect(shouldBypassBearerAuth("POST", "/api/files/upload")).toBe(false);
  });
});

describe("agent MCP request authorizer", () => {
  const CAPABILITY_TOKEN = "cap-token-abc123";

  test("allows any request when no daemon password is configured", async () => {
    expect(
      await isAgentMcpRequestAuthorized({
        password: undefined,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: undefined,
      }),
    ).toBe(true);
  });

  test("accepts the injected capability token", async () => {
    expect(
      await isAgentMcpRequestAuthorized({
        password: CORRECT_PASSWORD_HASH,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: `Bearer ${CAPABILITY_TOKEN}`,
      }),
    ).toBe(true);
  });

  test("still accepts a valid daemon-password bearer", async () => {
    expect(
      await isAgentMcpRequestAuthorized({
        password: CORRECT_PASSWORD_HASH,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: "Bearer correct-password",
      }),
    ).toBe(true);
  });

  test("rejects requests presenting neither the token nor a valid password", async () => {
    expect(
      await isAgentMcpRequestAuthorized({
        password: CORRECT_PASSWORD_HASH,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: undefined,
      }),
    ).toBe(false);
    expect(
      await isAgentMcpRequestAuthorized({
        password: CORRECT_PASSWORD_HASH,
        capabilityToken: CAPABILITY_TOKEN,
        authorizationHeader: "Bearer wrong-token",
      }),
    ).toBe(false);
  });
});

describe("loopback password exemption", () => {
  const AUTH = {
    password: CORRECT_PASSWORD_HASH,
    allowLoopbackWithoutPassword: true,
  };

  test("recognizes loopback peers, including IPv6 and IPv4-mapped forms", () => {
    for (const remoteAddress of [
      "127.0.0.1",
      "127.0.0.53",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackConnection({ remoteAddress, headers: {} })).toBe(true);
    }
  });

  test("treats a Unix socket peer, which has no address, as loopback", () => {
    expect(isLoopbackConnection({ remoteAddress: undefined, headers: {} })).toBe(true);
  });

  test("rejects non-loopback peers", () => {
    for (const remoteAddress of [
      "192.168.1.10",
      "10.0.0.4",
      "::ffff:192.168.1.10",
      "2001:db8::1",
    ]) {
      expect(isLoopbackConnection({ remoteAddress, headers: {} })).toBe(false);
    }
  });

  test("rejects a loopback peer that forwarded someone else's request", () => {
    // A reverse proxy on the same host connects from 127.0.0.1 for every remote
    // client, so a forwarding header means the real caller is not local.
    expect(
      isLoopbackConnection({
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
    ).toBe(false);
    expect(
      isLoopbackConnection({
        remoteAddress: "127.0.0.1",
        headers: { forwarded: "for=203.0.113.7" },
      }),
    ).toBe(false);
    expect(
      isLoopbackConnection({ remoteAddress: "127.0.0.1", headers: { "x-real-ip": "203.0.113.7" } }),
    ).toBe(false);
  });

  test("exempts loopback only when the config opts in", () => {
    const origin = { remoteAddress: "127.0.0.1", headers: {} };

    expect(isLoopbackPasswordExempt(AUTH, origin)).toBe(true);
    expect(isLoopbackPasswordExempt({ password: CORRECT_PASSWORD_HASH }, origin)).toBe(false);
    expect(
      isLoopbackPasswordExempt(
        { password: CORRECT_PASSWORD_HASH, allowLoopbackWithoutPassword: false },
        origin,
      ),
    ).toBe(false);
    expect(isLoopbackPasswordExempt(undefined, origin)).toBe(false);
  });

  test("never exempts a remote peer, even with the option on", () => {
    expect(isLoopbackPasswordExempt(AUTH, { remoteAddress: "192.168.1.10", headers: {} })).toBe(
      false,
    );
  });

  test("opens the agent MCP endpoint to exempt loopback callers", async () => {
    expect(
      await isAgentMcpRequestAuthorized({
        password: CORRECT_PASSWORD_HASH,
        capabilityToken: "cap-token-abc123",
        authorizationHeader: undefined,
        loopbackExempt: true,
      }),
    ).toBe(true);
  });
});
