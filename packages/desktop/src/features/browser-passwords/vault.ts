import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { BrowserImportLogin } from "@getpaseo/server/browser-import";

export interface PasswordCrypto {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(cipherText: Buffer): string;
}

export interface SavedCredential {
  username: string;
  password: string;
}

export interface SavedLogin {
  origin: string;
  username: string;
}

const storedEntrySchema = z.object({
  username: z.string(),
  password: z.string(),
  updatedAt: z.number(),
  lastUsedAt: z.number(),
});

const vaultFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.array(storedEntrySchema)),
  never: z.array(z.string()),
});

type VaultFile = z.infer<typeof vaultFileSchema>;
type StoredEntry = z.infer<typeof storedEntrySchema>;

export class PasswordVaultFileError extends Error {
  public constructor(
    public readonly filePath: string,
    cause: unknown,
  ) {
    super(`Password vault file is unreadable: ${filePath}`, { cause });
    this.name = "PasswordVaultFileError";
  }
}

export class PasswordVault {
  private file: VaultFile | null = null;

  public constructor(
    private readonly input: {
      filePath: string;
      crypto: PasswordCrypto;
      now?: () => number;
    },
  ) {}

  public isAvailable(): boolean {
    return this.input.crypto.isAvailable();
  }

  public save(origin: string, username: string, password: string): boolean {
    if (!this.isAvailable()) {
      return false;
    }
    const file = this.load();
    const now = this.now();
    const encrypted = this.input.crypto.encrypt(password).toString("base64");
    const entries = file.entries[origin] ?? [];
    const others = entries.filter((entry) => entry.username !== username);
    file.entries[origin] = [
      ...others,
      { username, password: encrypted, updatedAt: now, lastUsedAt: now },
    ];
    file.never = file.never.filter((neverOrigin) => neverOrigin !== origin);
    this.write(file);
    return true;
  }

  public lookup(origin: string): SavedCredential[] {
    if (!this.isAvailable()) {
      return [];
    }
    const file = this.load();
    const entries = file.entries[origin];
    if (!entries || entries.length === 0) {
      return [];
    }
    const sorted = [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const credentials = sorted.map((entry) => ({
      username: entry.username,
      password: this.decrypt(entry),
    }));
    sorted[0].lastUsedAt = this.now();
    file.entries[origin] = sorted;
    this.write(file);
    return credentials;
  }

  public has(origin: string, username: string, password: string): boolean {
    if (!this.isAvailable()) {
      return false;
    }
    const entry = this.load().entries[origin]?.find((candidate) => candidate.username === username);
    return entry !== undefined && this.decrypt(entry) === password;
  }

  public list(): SavedLogin[] {
    const logins = Object.entries(this.load().entries).flatMap(([origin, entries]) =>
      entries.map((entry) => ({ origin, username: entry.username })),
    );
    return logins.sort(
      (a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username),
    );
  }

  public exportLogins(): BrowserImportLogin[] {
    if (!this.isAvailable())
      throw new Error("Unlock the system keychain to access saved passwords.");
    return Object.entries(this.load().entries).flatMap(([origin, entries]) =>
      entries.map((entry) => ({ origin, username: entry.username, password: this.decrypt(entry) })),
    );
  }

  public importLogins(logins: BrowserImportLogin[]): {
    passwordCount: number;
    skippedPasswords: number;
  } {
    if (!this.isAvailable())
      throw new Error("Unlock the system keychain before importing passwords.");
    const file = structuredClone(this.load());
    let passwordCount = 0;
    for (const login of logins) {
      const entries = file.entries[login.origin] ?? [];

      if (entries.some((entry) => entry.username === login.username)) continue;
      const now = this.now();
      entries.push({
        username: login.username,
        password: this.input.crypto.encrypt(login.password).toString("base64"),
        updatedAt: now,
        lastUsedAt: now,
      });
      file.entries[login.origin] = entries;
      passwordCount += 1;
    }
    this.write(file);
    this.file = file;
    return { passwordCount, skippedPasswords: logins.length - passwordCount };
  }

  public remove(origin: string, username: string): void {
    const file = this.load();
    const entries = file.entries[origin];
    if (!entries) {
      return;
    }
    const remaining = entries.filter((entry) => entry.username !== username);
    if (remaining.length === 0) {
      delete file.entries[origin];
    } else {
      file.entries[origin] = remaining;
    }
    this.write(file);
  }

  public setNever(origin: string): void {
    const file = this.load();
    if (!file.never.includes(origin)) {
      file.never.push(origin);
      this.write(file);
    }
  }

  public isNever(origin: string): boolean {
    return this.load().never.includes(origin);
  }

  private decrypt(entry: StoredEntry): string {
    return this.input.crypto.decrypt(Buffer.from(entry.password, "base64"));
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private load(): VaultFile {
    if (this.file) {
      return this.file;
    }
    const { filePath } = this.input;
    if (!existsSync(filePath)) {
      this.file = { version: 1, entries: {}, never: [] };
      return this.file;
    }
    try {
      this.file = vaultFileSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
    } catch (error) {
      throw new PasswordVaultFileError(filePath, error);
    }
    return this.file;
  }

  private write(file: VaultFile): void {
    const tmpPath = `${this.input.filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmpPath, this.input.filePath);
  }
}
