import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { OWNER_PERMISSIONS, type DaemonPermission } from "./authorization/index.js";
import { writePrivateFileAtomic } from "./private-files.js";

const RecordSchema = z.object({
  id: z.string().regex(/^dc_[A-Za-z0-9_-]{22}$/),
  label: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  secretSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type CredentialRecord = z.infer<typeof RecordSchema>;
export interface CredentialAuthority {
  principalId: string;
  permissions: readonly DaemonPermission[];
  credentialId?: string;
  /** Admitted through another daemon's host link rather than directly. */
  routed?: boolean;
}
export function isFullOwner(authority: CredentialAuthority): boolean {
  return (
    authority.principalId === "owner" &&
    authority.routed !== true &&
    OWNER_PERMISSIONS.every((p) => authority.permissions.includes(p))
  );
}
function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export class DeviceCredentials {
  private records: CredentialRecord[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private readonly tokens = new Map<string, number>();
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  static async load(paseoHome: string, logger: Logger): Promise<DeviceCredentials> {
    const store = new DeviceCredentials(join(paseoHome, "device-credentials.json"));
    try {
      const records = z
        .array(RecordSchema)
        .max(64)
        .parse(JSON.parse(await readFile(store.file, "utf8")));
      if (new Set(records.map((record) => record.id)).size !== records.length)
        throw new Error("Duplicate credential ids");
      store.records = records;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return store;
      logger.error("Invalid device credential store; credentials disabled until reissued");
      await rename(store.file, `${store.file}.invalid-${store.now()}`).catch(() => {
        logger.error("Failed to quarantine device credential store");
      });
    }
    return store;
  }

  has(id: string): boolean {
    return this.records.some((record) => record.id === id);
  }
  accepts(id: string, secret: string): boolean {
    const record = this.records.find((candidate) => candidate.id === id);
    const expected = record?.secretSha256 ?? "0".repeat(64);
    const matches = timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(digest(secret), "hex"),
    );
    return record !== undefined && matches;
  }
  list(currentId?: string) {
    return this.records.map(({ id, label, createdAt }) => ({
      id,
      label,
      createdAt,
      current: id === currentId,
    }));
  }
  issue(label: string, authority: CredentialAuthority, passwordConfigured: boolean) {
    return this.serialize(async () => {
      if (!passwordConfigured)
        return { credential: null, error: "password_not_configured" as const };
      if (!isFullOwner(authority))
        return { credential: null, error: "unsupported_principal" as const };
      if (this.records.length >= 64) return { credential: null, error: "limit_reached" as const };
      const credential = {
        id: `dc_${randomBytes(16).toString("base64url")}`,
        secret: randomBytes(32).toString("base64url"),
        label,
        createdAt: new Date(this.now()).toISOString(),
      };
      const { secret, ...metadata } = credential;
      const records = [...this.records, { ...metadata, secretSha256: digest(secret) }];
      try {
        await this.persist(records);
      } catch {
        return { credential: null, error: "store_failed" as const };
      }
      return { credential, error: null };
    });
  }
  revoke(id: string): Promise<string[]> {
    return this.serialize(async () => {
      const removed = this.records
        .filter((record) => id === "*" || record.id === id)
        .map((record) => record.id);
      if (removed.length)
        await this.persist(this.records.filter((record) => !removed.includes(record.id)));
      return removed;
    });
  }
  mintToken(authority: CredentialAuthority, passwordConfigured: boolean): string | undefined {
    if (!passwordConfigured || !isFullOwner(authority)) return undefined;
    const now = this.now();
    for (const [key, expiry] of this.tokens) if (expiry <= now) this.tokens.delete(key);
    if (this.tokens.size >= 8) this.tokens.delete(this.tokens.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(digest(token), now + 10 * 60 * 1000);
    return token;
  }
  consumeToken(token: string): boolean {
    const key = digest(token);
    const expiry = this.tokens.get(key);
    this.tokens.delete(key);
    return expiry !== undefined && expiry > this.now();
  }
  private async persist(records: CredentialRecord[]): Promise<void> {
    await writePrivateFileAtomic(this.file, JSON.stringify(records));
    this.records = records;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }
}
