import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { z } from "zod";
import { BrowserImportCookieSchema } from "@getpaseo/protocol/browser-import/rpc-schemas";
import { BrowserImportLoginSchema } from "./browser-cookie-import.js";

const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
export class BrowserBackupError extends Error {}
function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(passphrase, salt, 32, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    }),
  );
}
const cookiesSchema = z
  .array(
    BrowserImportCookieSchema.extend({
      name: z.string().max(4096),
      value: z.string().max(65536),
      domain: z
        .string()
        .min(1)
        .max(253)
        .regex(/^\.?[a-zA-Z0-9_.:[\]-]+$/),
      path: z.string().max(4096).startsWith("/"),
      expires: z.number().min(-1).max(253_402_300_799),
    }),
  )
  .max(100_000);
export const BrowserBackupDataSchema = z
  .object({
    version: z.literal(1),
    cookies: cookiesSchema,
    logins: z.array(BrowserImportLoginSchema).max(100_000),
  })
  .strict();
export type BrowserBackupData = z.infer<typeof BrowserBackupDataSchema>;
const envelopeSchema = z
  .object({
    version: z.literal(1),
    salt: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
    iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    tag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
    data: z
      .string()
      .max(MAX_BACKUP_BYTES * 2)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();

function checkPassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024) {
    throw new BrowserBackupError("Use a backup passphrase with 12–1024 characters.");
  }
}

export async function encryptBrowserBackup(
  data: BrowserBackupData,
  passphrase: unknown,
): Promise<string> {
  checkPassphrase(passphrase);
  const plain = JSON.stringify(BrowserBackupDataSchema.parse(data));
  if (Buffer.byteLength(plain) > MAX_BACKUP_BYTES)
    throw new BrowserBackupError("Browser backup is too large.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("pandaos-browser-backup-v1"));
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  key.fill(0);
  return JSON.stringify({
    version: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  });
}

export async function decryptBrowserBackup(
  text: string,
  passphrase: unknown,
): Promise<BrowserBackupData> {
  checkPassphrase(passphrase);
  try {
    if (Buffer.byteLength(text) > MAX_BACKUP_BYTES * 2) throw new Error();
    const envelope = envelopeSchema.parse(JSON.parse(text));
    const key = await deriveKey(passphrase, Buffer.from(envelope.salt, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from("pandaos-browser-backup-v1"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    let plain: Buffer;
    try {
      plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]);
    } finally {
      key.fill(0);
    }
    if (plain.length > MAX_BACKUP_BYTES) throw new Error();
    return BrowserBackupDataSchema.parse(JSON.parse(plain.toString("utf8")));
  } catch {
    throw new BrowserBackupError(
      "The backup is damaged or the passphrase is incorrect. No data was restored.",
    );
  }
}
