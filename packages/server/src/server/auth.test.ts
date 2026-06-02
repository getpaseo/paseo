import { describe, expect, test } from "vitest";

import {
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  hashDaemonPassword,
  isAgentMcpRequestAuthorized,
  isBearerTokenValidAsync,
  isBearerTokenValid,
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
