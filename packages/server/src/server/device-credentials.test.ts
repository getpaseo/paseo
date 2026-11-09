import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { DeviceCredentials } from "./device-credentials.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { resolveSessionAdmission } from "./session-admission-auth.js";

const owner = { principalId: "owner", permissions: OWNER_PERMISSIONS };

describe("device credentials", () => {
  test("persists only digests, reloads and serializes issuance and revocation", async () => {
    const home = await mkdtemp(join(tmpdir(), "device-credentials-"));
    try {
      const store = await DeviceCredentials.load(home, pino({ enabled: false }));
      const result = await store.issue("Synthetic phone", owner, true);
      expect(result.error).toBeNull();
      if (!result.credential) throw new Error("Expected credential");
      const { id, secret } = result.credential;
      const file = await readFile(join(home, "device-credentials.json"), "utf8");
      expect(file).not.toContain(secret);
      if (process.platform !== "win32")
        expect((await stat(join(home, "device-credentials.json"))).mode & 0o777).toBe(0o600);
      const reloaded = await DeviceCredentials.load(home, pino({ enabled: false }));
      expect(reloaded.accepts(id, secret)).toBe(true);
      const resolve = (credential: Parameters<typeof resolveSessionAdmission>[0]["credential"]) =>
        resolveSessionAdmission({
          credential,
          passwordHash: "synthetic-hash",
          localCredential: null,
          deviceCredentials: reloaded,
        });
      await expect(resolve({ kind: "deviceCredential", id, secret })).resolves.toEqual({
        admission: { ...owner, credentialId: id },
      });
      await expect(resolve({ kind: "deviceCredential", id, secret: "wrong" })).resolves.toEqual({
        rejection: "incorrect_password",
      });
      await expect(resolve({ kind: "deviceCredential", id: "unknown", secret })).resolves.toEqual({
        rejection: "incorrect_password",
      });
      await expect(reloaded.revoke(id)).resolves.toEqual([id]);
      expect(reloaded.accepts(id, secret)).toBe(false);
      const issued = await Promise.all(
        Array.from({ length: 65 }, (_, i) => reloaded.issue(`Phone ${i}`, owner, true)),
      );
      expect(issued.filter((item) => item.error === null)).toHaveLength(64);
      expect(issued[64]?.error).toBe("limit_reached");
      await expect(reloaded.revoke("*")).resolves.toHaveLength(64);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rejects narrowed and non-owner issuers and open-daemon issuance", async () => {
    const store = new DeviceCredentials("unused");
    await expect(store.issue("Phone", owner, false)).resolves.toMatchObject({
      error: "password_not_configured",
    });
    for (const authority of [
      { principalId: "owner", permissions: ["access.manage"] as const },
      { principalId: "hub", permissions: OWNER_PERMISSIONS },
    ]) {
      await expect(store.issue("Phone", authority, true)).resolves.toMatchObject({
        error: "unsupported_principal",
      });
      expect(store.mintToken(authority, true)).toBeUndefined();
    }
  });

  test("consumes pairing tokens before concurrent admission and enforces expiry and cap", async () => {
    let now = 1000;
    const store = new DeviceCredentials("unused", () => now);
    const token = store.mintToken(owner, true)!;
    const resolve = () =>
      resolveSessionAdmission({
        credential: { kind: "pairingToken", token },
        passwordHash: "synthetic",
        localCredential: null,
        deviceCredentials: store,
      });
    expect(await Promise.all([resolve(), resolve()])).toEqual([
      { admission: owner },
      { rejection: "incorrect_password" },
    ]);
    const expired = store.mintToken(owner, true)!;
    now += 10 * 60 * 1000;
    expect(store.consumeToken(expired)).toBe(false);
    const oldest = store.mintToken(owner, true)!;
    for (let i = 0; i < 8; i++) store.mintToken(owner, true);
    expect(store.consumeToken(oldest)).toBe(false);
  });

  test("quarantines malformed stores and reports persistence failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "device-credentials-"));
    try {
      await writeFile(join(home, "device-credentials.json"), "malformed");
      const store = await DeviceCredentials.load(home, pino({ enabled: false }));
      expect(store.list()).toEqual([]);
      await expect(readFile(join(home, "device-credentials.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const failed = new DeviceCredentials(join(home, "device-credentials.json", "child"));
      await writeFile(join(home, "device-credentials.json"), "blocks directory");
      await expect(failed.issue("Phone", owner, true)).resolves.toMatchObject({
        error: "store_failed",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
