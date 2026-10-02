import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { BrowserImportCookieSchema } from "@getpaseo/protocol/browser-import/rpc-schemas";
import {
  BrowserImportError,
  BrowserImportLoginSchema,
  readBrowserProfileEncryptionKey,
} from "../browser-import/browser-cookie-import.js";
import { writeFileAtomic } from "../atomic-file.js";

const cookieStoreSchema = z.object({
  version: z.string(),
  cookies: z.array(BrowserImportCookieSchema).max(100_000),
  logins: z.array(BrowserImportLoginSchema).max(100_000).optional(),
});
export type ProfileCookieStore = z.infer<typeof cookieStoreSchema>;

export class ProfileCookieSecrets {
  private key: Buffer | null = null;
  public constructor(private readonly getKey = readBrowserProfileEncryptionKey) {}
  private async encryptionKey(): Promise<Buffer> {
    this.key ??= await this.getKey();
    return this.key;
  }
  public async write(file: string, store: ProfileCookieStore): Promise<void> {
    const key = await this.encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("pandaos-host-cookies-v1"));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(cookieStoreSchema.parse(store)), "utf8"),
      cipher.final(),
    ]);
    await writeFileAtomic(file, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), {
      mode: 0o600,
    });
  }
  public async read(file: string): Promise<ProfileCookieStore | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const key = await this.encryptionKey();
    try {
      if (encrypted.length < 28 || encrypted.length > 32 * 1024 * 1024) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
      decipher.setAAD(Buffer.from("pandaos-host-cookies-v1"));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
      return cookieStoreSchema.parse(JSON.parse(plain.toString("utf8")));
    } catch {
      throw new BrowserImportError(
        "The host's saved browser session could not be decrypted. Unlock the original keyring; existing profile data was preserved.",
      );
    }
  }
  public async migrate(legacyFile: string, encryptedFile: string): Promise<void> {
    if (await this.read(encryptedFile)) {
      await rm(legacyFile, { force: true });
      return;
    }
    let raw: string;
    try {
      raw = await readFile(legacyFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let store: ProfileCookieStore;
    try {
      store = cookieStoreSchema.parse(JSON.parse(raw));
    } catch {
      throw new BrowserImportError(
        "The legacy browser import file is invalid. Existing profile data was preserved.",
      );
    }
    await this.write(encryptedFile, store);
    await rm(legacyFile);
  }
}
