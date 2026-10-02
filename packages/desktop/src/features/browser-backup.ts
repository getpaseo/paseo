import { readFile, rename, writeFile } from "node:fs/promises";
import type { PasswordCrypto } from "./browser-passwords/vault.js";
import { BrowserBackupDataSchema, type BrowserBackupData } from "@getpaseo/server/browser-backup";
export {
  BrowserBackupError,
  encryptBrowserBackup,
  decryptBrowserBackup,
} from "@getpaseo/server/browser-backup";

export async function writeBrowserSessionCookies(
  file: string,
  cookies: BrowserBackupData["cookies"],
  crypto: PasswordCrypto,
): Promise<void> {
  if (!crypto.isAvailable())
    throw new Error("Unlock the system keychain to keep browser session logins after restarting.");
  const data = BrowserBackupDataSchema.parse({ version: 1, cookies, logins: [] });
  const encrypted = crypto.encrypt(JSON.stringify(data));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, encrypted, { mode: 0o600 });
  await rename(tmp, file);
}

export async function readBrowserSessionCookies(
  file: string,
  crypto: PasswordCrypto,
): Promise<BrowserBackupData["cookies"]> {
  let encrypted: Buffer;
  try {
    encrypted = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!crypto.isAvailable())
    throw new Error("Unlock the system keychain to restore browser session logins.");
  try {
    return BrowserBackupDataSchema.parse(JSON.parse(crypto.decrypt(encrypted))).cookies;
  } catch {
    throw new Error(
      "The saved browser session could not be unlocked. Existing browser data was preserved.",
    );
  }
}
