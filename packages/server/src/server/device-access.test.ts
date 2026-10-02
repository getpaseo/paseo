import { mkdirSync, mkdtempSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createPairingInvite, DeviceAccess, PAIRING_INVITE_TTL_MS } from "./device-access.js";

const CREDENTIAL = "c".repeat(43);
const OTHER = "o".repeat(43);
const homes: string[] = [];

function setup(locked: boolean, clock = { now: 1_000_000 }) {
  const home = mkdtempSync(path.join(os.tmpdir(), "device-access-"));
  homes.push(home);
  const access = new DeviceAccess({
    paseoHome: home,
    isLocked: () => locked,
    logger: pino({ level: "silent" }),
    now: () => clock.now,
  });
  return { home, access, clock };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("DeviceAccess", () => {
  it("rejects the daemon key alone once locked", () => {
    const { access } = setup(true);
    expect(access.admit({})).toEqual({ ok: false, reason: "missing_credential" });
    expect(access.admit({ deviceCredential: CREDENTIAL })).toEqual({
      ok: false,
      reason: "unknown_credential",
    });
  });

  it("pairs once through an invitation, then knows the device by its credential", () => {
    const { home, access } = setup(true);
    const invite = createPairingInvite(home, () => 1_000_000);
    const first = access.admit({ deviceCredential: CREDENTIAL, pairingInvite: invite });
    expect(first.ok).toBe(true);
    expect(access.admit({ deviceCredential: CREDENTIAL })).toEqual(first);

    expect(access.admit({ deviceCredential: OTHER, pairingInvite: invite })).toEqual({
      ok: false,
      reason: "invalid_invite",
    });
  });

  it("refuses an expired invitation", () => {
    const { home, access, clock } = setup(true);
    const invite = createPairingInvite(home, () => clock.now);
    clock.now += PAIRING_INVITE_TTL_MS + 1;
    expect(access.admit({ deviceCredential: CREDENTIAL, pairingInvite: invite }).ok).toBe(false);
  });

  it("adopts up-to-date devices while unlocked and keeps them after the lock and a restart", () => {
    const { home, access } = setup(false);
    expect(access.admit({})).toEqual({ ok: true, deviceId: null });
    const adopted = access.admit({ deviceCredential: CREDENTIAL });
    expect(adopted.ok && adopted.deviceId).toMatch(/^dev_/);

    const locked = new DeviceAccess({
      paseoHome: home,
      isLocked: () => true,
      logger: pino({ level: "silent" }),
    });
    expect(locked.admit({ deviceCredential: CREDENTIAL })).toEqual(adopted);
  });

  it("forgets a revoked device", () => {
    const { home, access } = setup(true);
    const invite = createPairingInvite(home);
    const admitted = access.admit({ deviceCredential: CREDENTIAL, pairingInvite: invite });
    expect(admitted.ok && access.revoke(admitted.deviceId!)).toBe(true);
    expect(access.admit({ deviceCredential: CREDENTIAL }).ok).toBe(false);
  });
});

it("keeps revocation after reload even while adoption is allowed", () => {
  const { home, access } = setup(false);
  const admitted = access.admit({ deviceCredential: CREDENTIAL });
  expect(admitted.ok).toBe(true);
  if (!admitted.ok || !admitted.deviceId) throw new Error("Device was not registered");
  access.revoke(admitted.deviceId);
  const reloaded = new DeviceAccess({
    paseoHome: home,
    isLocked: () => false,
    logger: pino({ level: "silent" }),
  });
  expect(reloaded.admit({ deviceCredential: CREDENTIAL })).toEqual({
    ok: false,
    reason: "unknown_credential",
  });
  const invite = createPairingInvite(home);
  expect(reloaded.admit({ deviceCredential: CREDENTIAL, pairingInvite: invite }).ok).toBe(true);
  expect(readFileSync(path.join(home, "paired-devices.json"), "utf8")).not.toContain(CREDENTIAL);
});

it("does not replace a corrupt device registry with an empty one", () => {
  const { home } = setup(true);
  const file = path.join(home, "paired-devices.json");
  writeFileSync(file, "corrupted");
  expect(
    () =>
      new DeviceAccess({
        paseoHome: home,
        isLocked: () => true,
        logger: pino({ level: "silent" }),
      }),
  ).toThrow("registry could not be read");
  expect(readFileSync(file, "utf8")).toBe("corrupted");
});

it("keeps a failed revocation retryable until the registry is persisted", () => {
  const { home, access } = setup(false);
  const admitted = access.admit({ deviceCredential: CREDENTIAL });
  if (!admitted.ok || !admitted.deviceId) throw new Error("Device was not registered");
  const file = path.join(home, "paired-devices.json");
  const backup = `${file}.backup`;
  renameSync(file, backup);
  mkdirSync(file);
  expect(() => access.revoke(admitted.deviceId!)).toThrow();
  expect(access.list().map((device) => device.id)).toEqual([admitted.deviceId]);
  rmSync(file, { recursive: true });
  renameSync(backup, file);
  expect(access.admit({ deviceCredential: CREDENTIAL })).toEqual(admitted);
  expect(access.revoke(admitted.deviceId)).toBe(true);
  expect(access.list()).toEqual([]);
  const reloaded = new DeviceAccess({
    paseoHome: home,
    isLocked: () => false,
    logger: pino({ level: "silent" }),
  });
  expect(reloaded.admit({ deviceCredential: CREDENTIAL })).toEqual({
    ok: false,
    reason: "unknown_credential",
  });
});
