import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CookiesSetDetails } from "electron";

const exec = promisify(execFile);
export interface CometProfile {
  id: string;
  name: string;
}
export interface CometImportResult {
  status: "complete" | "partial";
  imported: number;
  skipped: number;
  failed: number;
  reason?: string;
}
export interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted: string;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  has_expires: number;
  top_frame_site_key: string;
}

export function decodeCometCookie(row: CookieRow, password: string): CookiesSetDetails | null {
  if (row.top_frame_site_key) return null;
  const expirationDate = row.expires_utc / 1_000_000 - 11644473600;
  if (row.has_expires && expirationDate <= Date.now() / 1000) return null;
  if (!row.host_key || !row.path.startsWith("/") || ![-1, 0, 1, 2].includes(row.samesite))
    return null;
  let value = row.value;
  if (row.encrypted) {
    const encrypted = Buffer.from(row.encrypted, "hex");
    if (encrypted.subarray(0, 3).toString() !== "v10") throw new Error("unsupported encryption");
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    const digest = createHash("sha256").update(row.host_key).digest();
    if (plaintext.length < 32 || !timingSafeEqual(plaintext.subarray(0, 32), digest))
      throw new Error("invalid domain digest");
    value = new TextDecoder("utf-8", { fatal: true }).decode(plaintext.subarray(32));
  }
  const host = row.host_key.replace(/^\./, "");
  const url = new URL(`${row.is_secure ? "https" : "http"}://${host}${row.path}`);
  if (url.hostname !== host || url.username || url.password) return null;
  return {
    url: url.href,
    name: row.name,
    value,
    path: row.path,
    ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    sameSite: (["unspecified", "no_restriction", "lax", "strict"] as const)[row.samesite + 1],
    ...(row.has_expires ? { expirationDate } : {}),
  };
}

export class CometProfileImporter {
  private readonly profiles = new Map<string, string>();
  constructor(
    private readonly root = path.join(homedir(), "Library/Application Support/Comet"),
    private readonly readPassword = async () =>
      (
        await exec("/usr/bin/security", ["find-generic-password", "-s", "Comet Safe Storage", "-w"])
      ).stdout.replace(/\r?\n$/, ""),
  ) {}

  async listProfiles(): Promise<CometProfile[]> {
    if (process.platform !== "darwin") return [];
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Impossible d’ouvrir les profils Comet.", { cause: error });
    }
    let names: Record<string, { name?: string }> = {};
    try {
      names =
        JSON.parse(await readFile(path.join(this.root, "Local State"), "utf8")).profile
          ?.info_cache ?? {};
    } catch {
      /* Profile names are optional. */
    }
    const result: CometProfile[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue;
      const directory = await realpath(path.join(this.root, entry.name));
      if (path.dirname(directory) !== (await realpath(this.root))) continue;
      let id = [...this.profiles].find(([, value]) => value === directory)?.[0];
      if (!id) {
        id = randomUUID();
        this.profiles.set(id, directory);
      }
      result.push({
        id,
        name: typeof names[entry.name]?.name === "string" ? names[entry.name].name! : entry.name,
      });
    }
    return result;
  }

  async importProfile(
    profileId: string,
    cookies: { set(details: CookiesSetDetails): Promise<void>; flushStore(): Promise<void> },
  ): Promise<CometImportResult> {
    const directory = this.profiles.get(profileId);
    if (process.platform !== "darwin" || !directory)
      throw new Error("Profil Comet indisponible. Réessayez.");
    const temp = await mkdtemp(path.join(tmpdir(), "paseo-comet-"));
    try {
      const snapshot = path.join(temp, "Cookies");
      try {
        await exec("/usr/bin/sqlite3", [
          "-readonly",
          path.join(directory, "Cookies"),
          ".timeout 5000",
          `.backup '${snapshot.replaceAll("'", "''")}'`,
        ]);
      } catch {
        throw new Error("Impossible de lire les connexions Comet. Réessayez.");
      }
      const query = async (sql: string) =>
        JSON.parse(
          (
            await exec("/usr/bin/sqlite3", ["-json", snapshot, sql], {
              maxBuffer: 64 * 1024 * 1024,
            })
          ).stdout || "[]",
        );
      let rows: CookieRow[];
      try {
        const meta = await query("SELECT value FROM meta WHERE key='version'");
        if (String(meta[0]?.value) !== "24") throw new Error();
        rows = await query(
          "SELECT host_key,name,value,hex(encrypted_value) AS encrypted,path,expires_utc,is_secure,is_httponly,samesite,has_expires,top_frame_site_key FROM cookies",
        );
      } catch {
        throw new Error("Cette version des données Comet n’est pas prise en charge.");
      }
      let password: string;
      try {
        password = await this.readPassword();
      } catch {
        throw new Error("Accès au Trousseau refusé ou clé Comet indisponible.");
      }
      const prepared: CookiesSetDetails[] = [];
      const result: CometImportResult = { status: "complete", imported: 0, skipped: 0, failed: 0 };
      for (const row of rows) {
        try {
          const cookie = decodeCometCookie(row, password);
          if (cookie) prepared.push(cookie);
          else result.skipped++;
        } catch {
          result.failed++;
        }
      }
      // Prepare every cookie before the first write; never send values across IPC.
      for (const cookie of prepared) {
        try {
          await cookies.set(cookie);
          result.imported++;
        } catch {
          result.failed++;
        }
      }
      try {
        await cookies.flushStore();
      } catch {
        result.status = "partial";
        result.reason = "Enregistrement incomplet. Réessayez.";
      }
      if (result.failed) {
        result.status = "partial";
        result.reason = "Certaines connexions n’ont pas pu être importées.";
      }
      return result;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
