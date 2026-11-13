import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  credentialIdentity,
  CredentialMonitor,
  readCredentialFile,
  readCredentialState,
} from "./internal/credentials.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fixture(email = "first@example.com", access = "fixture-access") {
  return JSON.stringify({
    auth_method: "consumer",
    id_token_email: email,
    token: { access_token: access, refresh_token: "fixture-refresh" },
  });
}

it("uses stable account identity through access and refresh token renewal and decodes Keychain envelopes", () => {
  const expected = credentialIdentity(fixture());
  expect(expected.status).toBe("available");
  expect(credentialIdentity(fixture(" FIRST@example.com ", "renewed"))).toEqual(expected);
  expect(credentialIdentity(fixture("second@example.com"))).not.toEqual(expected);
  expect(
    credentialIdentity(`go-keyring-base64:${Buffer.from(fixture()).toString("base64")}`),
  ).toEqual(expected);
  expect(
    credentialIdentity(`go-keyring-encoded:${Buffer.from(fixture()).toString("hex")}`),
  ).toEqual(expected);
  expect(JSON.stringify(expected)).not.toContain("fixture-access");
  expect(JSON.stringify(expected)).not.toContain("first@example.com");
});

it("distinguishes missing tokens from unreadable data", () => {
  expect(credentialIdentity('{"id_token_email":"first@example.com","token":{}}')).toEqual({
    status: "signed-out",
  });
  expect(credentialIdentity("{incomplete")).toEqual({ status: "unavailable" });
  expect(credentialIdentity(JSON.stringify({ refresh_token: "fixture-refresh" })).status).toBe(
    "available",
  );
});

it("reads SSH fallback files and the explicit keyring-unavailable fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agy-credentials-"));
  dirs.push(dir);
  const env = { ANTIGRAVITY_EXECUTABLE_DATA_DIR: dir, SSH_CONNECTION: "fixture" };
  expect(await readCredentialFile(env)).toEqual({ status: "signed-out" });
  await writeFile(path.join(dir, "antigravity-oauth-token"), fixture());
  expect(await readCredentialState(env)).toEqual(credentialIdentity(fixture()));
  await mkdir(path.join(dir, "cache"));
  await writeFile(path.join(dir, "cache", "antigravity-keyring-unavailable"), "");
  expect(
    await readCredentialState({
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dir,
      DBUS_SESSION_BUS_ADDRESS: "fixture-unreachable",
    }),
  ).toEqual(credentialIdentity(fixture()));
});

it("shares polls and keeps the last known identity through read errors, and disposes the final subscription", async () => {
  vi.useFakeTimers();
  let state = credentialIdentity(fixture());
  let reads = 0;
  const monitor = new CredentialMonitor({
    intervalMs: 100,
    read: async () => {
      reads++;
      return state;
    },
  });
  let changes = 0;
  const one = monitor.watch({}, () => {
    changes++;
  });
  const two = monitor.watch({}, () => {
    changes++;
  });
  await Promise.all([one.read(), two.read()]);
  expect(reads).toBe(1);
  state = { status: "unavailable" };
  await vi.advanceTimersByTimeAsync(100);
  state = credentialIdentity(fixture());
  await vi.advanceTimersByTimeAsync(100);
  expect(changes).toBe(0);
  one.dispose();
  state = credentialIdentity(fixture("second@example.com"));
  await vi.advanceTimersByTimeAsync(100);
  expect(changes).toBe(1);
  two.dispose();
  const finalReads = reads;
  await vi.advanceTimersByTimeAsync(500);
  expect(reads).toBe(finalReads);
});
