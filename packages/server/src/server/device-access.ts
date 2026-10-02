import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import { editPersistedConfig } from "./persisted-config.js";

export const PAIRING_INVITE_TTL_MS = 10 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

export interface PairedDevice {
  id: string;
  credentialHash: string;

  via: "invite" | "adopted";
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface PairedDeviceManagement {
  list(): Array<Omit<PairedDevice, "credentialHash"> & { current: boolean }>;
  revoke(deviceId: string): boolean;
  isLocked(): boolean;

  setLocked(locked: boolean): void;
}

export const LOCK_CONFIG_FIELD = "daemon.relay.requireDeviceCredential";

export type DeviceAdmission =
  | { ok: true; deviceId: string | null }
  | { ok: false; reason: "missing_credential" | "unknown_credential" | "invalid_invite" };

export interface DeviceAdmissionInput {
  deviceCredential?: string;
  pairingInvite?: string;
  appVersion?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= MIN_SECRET_LENGTH;
}

function invitesDir(paseoHome: string): string {
  return path.join(paseoHome, "pairing-invites");
}

function pruneExpiredInvites(dir: string, nowMs: number): void {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      const { expiresAt } = JSON.parse(readFileSync(file, "utf8")) as { expiresAt: number };
      if (expiresAt < nowMs) unlinkSync(file);
    } catch {}
  }
}

export function createPairingInvite(
  paseoHome: string,
  now: () => number = Date.now,
  ttlMs: number = PAIRING_INVITE_TTL_MS,
): string {
  const secret = randomBytes(32).toString("base64url");
  const dir = invitesDir(paseoHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneExpiredInvites(dir, now());
  writeFileSync(
    path.join(dir, `${sha256(secret)}.json`),
    JSON.stringify({ expiresAt: now() + ttlMs }),
    { mode: 0o600 },
  );
  return secret;
}

export class DeviceAccess {
  private devices: PairedDevice[];
  private revokedHashes: string[] = [];
  private readonly file: string;

  public constructor(
    private readonly options: {
      paseoHome: string;
      isLocked: () => boolean;
      logger: pino.Logger;
      now?: () => number;
    },
  ) {
    this.file = path.join(options.paseoHome, "paired-devices.json");
    this.devices = this.read();
  }

  public admit(input: DeviceAdmissionInput): DeviceAdmission {
    const credential = isSecret(input.deviceCredential) ? input.deviceCredential : null;
    if (credential) {
      const known = this.devices.find((device) => device.credentialHash === sha256(credential));
      if (known) {
        this.touch(known, input.appVersion);
        return { ok: true, deviceId: known.id };
      }
      if (isSecret(input.pairingInvite) && this.consumeInvite(input.pairingInvite)) {
        return { ok: true, deviceId: this.register(credential, "invite", input.appVersion).id };
      }
    }
    if (credential && this.revokedHashes.includes(sha256(credential))) {
      return { ok: false, reason: "unknown_credential" };
    }
    if (this.options.isLocked()) {
      if (!credential) return { ok: false, reason: "missing_credential" };
      return {
        ok: false,
        reason: isSecret(input.pairingInvite) ? "invalid_invite" : "unknown_credential",
      };
    }
    if (!credential) return { ok: true, deviceId: null };
    return { ok: true, deviceId: this.register(credential, "adopted", input.appVersion).id };
  }

  public isLocked(): boolean {
    return this.options.isLocked();
  }

  public setLocked(locked: boolean): void {
    editPersistedConfig(this.options.paseoHome, LOCK_CONFIG_FIELD, { value: locked });
  }

  public list(): PairedDevice[] {
    return [...this.devices];
  }

  public revoke(deviceId: string): boolean {
    const next = this.devices.filter((device) => device.id !== deviceId);
    if (next.length === this.devices.length) return false;
    const revoked = this.devices.find((device) => device.id === deviceId)!;
    const revokedHashes = [...new Set([...this.revokedHashes, revoked.credentialHash])];
    this.write(next, revokedHashes);
    this.revokedHashes = revokedHashes;
    this.devices = next;
    return true;
  }

  private consumeInvite(secret: string): boolean {
    const file = path.join(invitesDir(this.options.paseoHome), `${sha256(secret)}.json`);
    let expiresAt: number;
    try {
      expiresAt = (JSON.parse(readFileSync(file, "utf8")) as { expiresAt: number }).expiresAt;
      unlinkSync(file);
    } catch {
      return false;
    }
    return this.nowMs() <= expiresAt;
  }

  private register(
    credential: string,
    via: PairedDevice["via"],
    appVersion: string | undefined,
  ): PairedDevice {
    const at = new Date(this.nowMs()).toISOString();
    const device: PairedDevice = {
      id: `dev_${randomBytes(6).toString("hex")}`,
      credentialHash: sha256(credential),
      via,
      appVersion: appVersion ?? null,
      createdAt: at,
      lastSeenAt: at,
    };
    const revokedHashes = this.revokedHashes.filter((hash) => hash !== device.credentialHash);
    const devices = [...this.devices, device];
    this.write(devices, revokedHashes);
    this.revokedHashes = revokedHashes;
    this.devices = devices;
    this.options.logger.info({ deviceId: device.id, via }, "Paired device registered");
    return device;
  }

  private touch(device: PairedDevice, appVersion: string | undefined): void {
    const devices = this.devices.map((entry) =>
      entry.id === device.id
        ? {
            ...entry,
            lastSeenAt: new Date(this.nowMs()).toISOString(),
            appVersion: appVersion || entry.appVersion,
          }
        : entry,
    );
    this.write(devices, this.revokedHashes);
    this.devices = devices;
  }

  private read(): PairedDevice[] {
    try {
      const parsed = z
        .object({
          devices: z.array(
            z.object({
              id: z.string().min(1),
              credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
              via: z.enum(["invite", "adopted"]),
              appVersion: z.string().nullable(),
              createdAt: z.string(),
              lastSeenAt: z.string(),
            }),
          ),
          revokedHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
        })
        .parse(JSON.parse(readFileSync(this.file, "utf8")));
      this.revokedHashes = parsed.revokedHashes ?? [];
      return parsed.devices;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Paired device registry could not be read", { cause: error });
    }
  }

  private write(devices: PairedDevice[], revokedHashes: string[]): void {
    mkdirSync(this.options.paseoHome, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices, revokedHashes }, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, this.file);
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }
}
