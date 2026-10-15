import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  hashDaemonPassword,
  isAgentMcpRequestAuthorized,
  isBearerTokenValidAsync,
  shouldBypassBearerAuth,
} from "./auth.js";
import { resolveSessionAdmission } from "./session-admission-auth.js";
import {
  deleteLocalCredential,
  readLocalCredentialForTarget,
  writeLocalCredential,
} from "./local-credential.js";

const CORRECT_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

describe("daemon bearer validator", () => {
  test("allows any token when no password is configured", async () => {
    expect(await isBearerTokenValidAsync({ password: undefined, token: null })).toBe(true);
    expect(await isBearerTokenValidAsync({ password: undefined, token: "anything" })).toBe(true);
  });

  test("accepts the plaintext token against the bcrypt hash and rejects missing or wrong tokens", async () => {
    expect(
      await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "correct-password" }),
    ).toBe(true);
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: null })).toBe(
      false,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "wrong" })).toBe(
      false,
    );
  });

  test("hashes a password into a bcrypt value", async () => {
    const hash = hashDaemonPassword("correct-password");

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await isBearerTokenValidAsync({ password: hash, token: "correct-password" })).toBe(true);
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

describe("hello admission", () => {
  test("admits a stale local credential when no password is configured", async () => {
    expect(
      await resolveSessionAdmission({
        credential: { kind: "localCredential", token: "stale" },
        passwordHash: undefined,
        localCredential: "current",
        transport: "direct",
      }),
    ).toMatchObject({ admission: { principalId: "owner" } });
  });
  test("accepts a password and current local credential, but rejects old and wrong credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-local-auth-"));
    try {
      const first = await writeLocalCredential(home);
      const second = await writeLocalCredential(home);
      const input = {
        passwordHash: CORRECT_PASSWORD_HASH,
        localCredential: second,
        transport: "direct" as const,
      };
      expect(
        await resolveSessionAdmission({
          ...input,
          credential: { kind: "password", password: "correct-password" },
        }),
      ).toMatchObject({ admission: { principalId: "owner" } });
      expect(
        await resolveSessionAdmission({
          ...input,
          credential: { kind: "localCredential", token: second },
        }),
      ).toMatchObject({ admission: { principalId: "owner" } });
      expect(
        await resolveSessionAdmission({
          ...input,
          credential: { kind: "localCredential", token: first },
        }),
      ).toEqual({ rejection: "incorrect_password" });
      expect(
        await resolveSessionAdmission({
          ...input,
          credential: { kind: "password", password: "wrong" },
        }),
      ).toEqual({ rejection: "incorrect_password" });
      expect(
        await resolveSessionAdmission({
          ...input,
          transport: "relay",
          credential: { kind: "password", password: "wrong" },
        }),
      ).toEqual({ rejection: "incorrect_password" });
      expect(await resolveSessionAdmission({ ...input, credential: undefined })).toEqual({
        rejection: "password_required",
      });
      expect(
        await resolveSessionAdmission({ ...input, transport: "relay", credential: undefined }),
      ).toMatchObject({ admission: { principalId: "owner" } });
    } finally {
      await deleteLocalCredential(home);
      await rm(home, { recursive: true, force: true });
    }
  });

  test("writes a private rotating credential and reads it only for the matching target", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-local-file-"));
    try {
      await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6767" }));
      const first = await writeLocalCredential(home);
      if (process.platform !== "win32") {
        expect((await stat(join(home, "local-credential"))).mode & 0o777).toBe(0o600);
      }
      expect(readLocalCredentialForTarget(home, "tcp://localhost:6767")).toBe(first);
      expect(readLocalCredentialForTarget(home, "tcp://remote.example:6767")).toBeNull();
      const second = await writeLocalCredential(home);
      expect(second).not.toBe(first);
      expect((await readFile(join(home, "local-credential"), "utf8")).trim()).toBe(second);
      await deleteLocalCredential(home);
      expect(readLocalCredentialForTarget(home, "localhost:6767")).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
