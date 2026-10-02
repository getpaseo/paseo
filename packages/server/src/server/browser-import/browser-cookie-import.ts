import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { BrowserImportLoginSchema } from "@getpaseo/protocol/browser-import/rpc-schemas";
import type {
  BrowserImportCookie,
  BrowserImportSource,
} from "@getpaseo/protocol/browser-import/rpc-schemas";
import { execCommand } from "../../utils/spawn.js";

export type { BrowserImportCookie, BrowserImportSource };

export class BrowserImportError extends Error {}

export interface ChromiumBrowser {
  key: string;
  name: string;
  macDir: string | null;
  macKeychainService: string;
  linuxDir: string | null;
  linuxSecretApplication: string;
}

const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  {
    key: "chrome",
    name: "Google Chrome",
    macDir: "Google/Chrome",
    macKeychainService: "Chrome Safe Storage",
    linuxDir: "google-chrome",
    linuxSecretApplication: "chrome",
  },
  {
    key: "chromium",
    name: "Chromium",
    macDir: "Chromium",
    macKeychainService: "Chromium Safe Storage",
    linuxDir: "chromium",
    linuxSecretApplication: "chromium",
  },
  {
    key: "brave",
    name: "Brave",
    macDir: "BraveSoftware/Brave-Browser",
    macKeychainService: "Brave Safe Storage",
    linuxDir: "BraveSoftware/Brave-Browser",
    linuxSecretApplication: "brave",
  },
  {
    key: "edge",
    name: "Microsoft Edge",
    macDir: "Microsoft Edge",
    macKeychainService: "Microsoft Edge Safe Storage",
    linuxDir: "microsoft-edge",
    linuxSecretApplication: "microsoft-edge",
  },
  {
    key: "arc",
    name: "Arc",
    macDir: "Arc/User Data",
    macKeychainService: "Arc Safe Storage",
    linuxDir: null,
    linuxSecretApplication: "arc",
  },
  {
    key: "vivaldi",
    name: "Vivaldi",
    macDir: "Vivaldi",
    macKeychainService: "Vivaldi Safe Storage",
    linuxDir: "vivaldi",
    linuxSecretApplication: "vivaldi",
  },
];

const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;

const MAX_COOKIE_EXPIRES_SECONDS = 253_402_300_799;
const CHROMIUM_IV = Buffer.alloc(16, 0x20);

interface ResolvedSource extends BrowserImportSource {
  family: "chromium" | "firefox";
  cookiesPath: string | null;
  profilePath: string;
  browser?: ChromiumBrowser;
}

export interface BrowserImportEnvironment {
  homeDir: string;
  platform: NodeJS.Platform;
  nowSeconds: number;

  readSafeStoragePassword: (browser: ChromiumBrowser) => Promise<string | null>;
}

export function defaultBrowserImportEnvironment(): BrowserImportEnvironment {
  const platform = process.platform;
  return {
    homeDir: os.homedir(),
    platform,
    nowSeconds: Date.now() / 1000,
    readSafeStoragePassword: (browser) =>
      platform === "darwin"
        ? readMacKeychainPassword(browser.macKeychainService)
        : readLinuxSecretPassword(browser.linuxSecretApplication),
  };
}

export async function listBrowserImportSources(
  env: BrowserImportEnvironment = defaultBrowserImportEnvironment(),
): Promise<BrowserImportSource[]> {
  const sources = await resolveSources(env);
  return sources.map(({ id, browserName, profileName }) => ({ id, browserName, profileName }));
}

export async function readBrowserImportCookies(
  sourceId: string,
  env: BrowserImportEnvironment = defaultBrowserImportEnvironment(),
): Promise<BrowserImportCookie[]> {
  const source = (await resolveSources(env)).find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new BrowserImportError(`Browser profile ${sourceId} was not found on this device.`);
  }
  if (!source.cookiesPath) return [];
  return withDatabaseCopy(source.cookiesPath, async (db) =>
    source.family === "firefox"
      ? readFirefoxCookies(db, env.nowSeconds)
      : readChromiumCookies(db, source.browser!, env),
  );
}

export { BrowserImportLoginSchema };
export type BrowserImportLogin = z.infer<typeof BrowserImportLoginSchema>;

export async function readBrowserImportPasswords(
  sourceId: string,
  env: BrowserImportEnvironment = defaultBrowserImportEnvironment(),
  primaryPassword = "",
): Promise<BrowserImportLogin[]> {
  const source = (await resolveSources(env)).find((candidate) => candidate.id === sourceId);
  if (!source) throw new BrowserImportError("Browser profile was not found on this device.");
  if (source.family === "firefox") return readFirefoxPasswords(source.profilePath, primaryPassword);
  const loginPath = path.join(source.profilePath, "Login Data");
  if (!existsSync(loginPath)) return [];
  return withDatabaseCopy(loginPath, async (db) => {
    const rows = readAllRows(
      db,
      "SELECT origin_url, username_value, password_value FROM logins WHERE blacklisted_by_user = 0",
    );
    const encryptedRows = rows.map((row) => ({ encrypted_value: row.password_value }));
    const keys = await chromiumKeys(encryptedRows, source.browser!, env);
    const logins: BrowserImportLogin[] = [];
    for (const row of rows) {
      const encrypted = Buffer.from(row.password_value as Uint8Array);
      if (encrypted.length === 0) continue;
      const password = decryptChromiumCookieValue({ encrypted, keys, domain: "", metaVersion: 0 });
      if (password === null)
        throw new BrowserImportError(keyringHelp(source.browser!, env.platform));
      let origin: string;
      try {
        origin = new URL(String(row.origin_url)).origin;
      } catch {
        continue;
      }
      const login = BrowserImportLoginSchema.safeParse({
        origin,
        username: String(row.username_value),
        password,
      });
      if (login.success) logins.push(login.data);
    }
    return logins;
  });
}

const FIREFOX_DECRYPT_SCRIPT = String.raw`
import base64, ctypes, ctypes.util, json, os, sys
try:
    profile, primary = json.load(sys.stdin)
    library = ctypes.util.find_library('nss3')
    if not library:
        library = '/Applications/Firefox.app/Contents/MacOS/libnss3.dylib'
    nss = ctypes.CDLL(library)
    class Item(ctypes.Structure):
        _fields_ = [('type', ctypes.c_uint), ('data', ctypes.c_void_p), ('len', ctypes.c_uint)]
    nss.NSS_Init.argtypes = [ctypes.c_char_p]
    nss.NSS_Init.restype = ctypes.c_int
    nss.PK11_GetInternalKeySlot.restype = ctypes.c_void_p
    nss.PK11_CheckUserPassword.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    nss.PK11_FreeSlot.argtypes = [ctypes.c_void_p]
    nss.PK11SDR_Decrypt.argtypes = [ctypes.POINTER(Item), ctypes.POINTER(Item), ctypes.c_void_p]
    nss.SECITEM_FreeItem.argtypes = [ctypes.POINTER(Item), ctypes.c_int]
    if nss.NSS_Init(('sql:' + profile).encode()) != 0: raise RuntimeError()
    slot = nss.PK11_GetInternalKeySlot()
    if not slot or nss.PK11_CheckUserPassword(slot, primary.encode()) != 0: raise RuntimeError()
    def decrypt(value):
        raw = base64.b64decode(value, validate=True)
        buf = ctypes.create_string_buffer(raw)
        source = Item(0, ctypes.cast(buf, ctypes.c_void_p), len(raw))
        target = Item()
        if nss.PK11SDR_Decrypt(ctypes.byref(source), ctypes.byref(target), None) != 0: raise RuntimeError()
        try: return ctypes.string_at(target.data, target.len).decode('utf8')
        finally: nss.SECITEM_FreeItem(ctypes.byref(target), 0)
    with open(os.path.join(profile, 'logins.json')) as f: records = json.load(f)['logins']
    result = [{'origin': r['hostname'], 'username': decrypt(r['encryptedUsername']), 'password': decrypt(r['encryptedPassword'])} for r in records]
    nss.PK11_FreeSlot(slot)
    nss.NSS_Shutdown()
    json.dump(result, sys.stdout)
except Exception:
    sys.exit(1)
`;

async function readFirefoxPasswords(
  profilePath: string,
  primaryPassword: string,
): Promise<BrowserImportLogin[]> {
  if (!existsSync(path.join(profilePath, "logins.json"))) return [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-firefox-import-"));
  try {
    for (const name of ["logins.json", "key4.db", "cert9.db"]) {
      for (const suffix of ["", "-wal", "-journal"]) {
        const file = path.join(profilePath, name + suffix);
        if (existsSync(file)) await copyFile(file, path.join(tempDir, name + suffix));
      }
    }
    const { execFile } = await import("node:child_process");
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "python3",
        ["-c", FIREFOX_DECRYPT_SCRIPT],
        { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error)
            reject(
              new BrowserImportError(
                "Firefox passwords could not be unlocked. Enter its Primary Password if set. Python 3 and Firefox's NSS library must be installed on this device.",
              ),
            );
          else resolve(stdout);
        },
      );
      child.stdin!.end(JSON.stringify([tempDir, primaryPassword]));
    });
    const parsed = z.array(BrowserImportLoginSchema).safeParse(JSON.parse(output));
    if (!parsed.success) throw new BrowserImportError("Firefox returned invalid login data.");
    return parsed.data;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveSources(env: BrowserImportEnvironment): Promise<ResolvedSource[]> {
  const sources: ResolvedSource[] = [];
  for (const browser of CHROMIUM_BROWSERS) {
    const root = chromiumRoot(browser, env);
    if (!root) continue;
    for (const profile of await listChromiumProfiles(root)) {
      const cookiesPath = [
        path.join(root, profile.dir, "Network", "Cookies"),
        path.join(root, profile.dir, "Cookies"),
      ].find((candidate) => existsSync(candidate));
      const profilePath = path.join(root, profile.dir);
      if (!cookiesPath && !existsSync(path.join(profilePath, "Login Data"))) continue;
      sources.push({
        id: `${browser.key}:${profile.dir}`,
        browserName: browser.name,
        profileName: profile.name,
        family: "chromium",
        cookiesPath: cookiesPath ?? null,
        profilePath,
        browser,
      });
    }
  }
  for (const root of firefoxRoots(env)) {
    for (const profile of await listFirefoxProfiles(root)) {
      const cookiesPath = path.join(profile.dir, "cookies.sqlite");
      const hasCookies = existsSync(cookiesPath);
      if (!hasCookies && !existsSync(path.join(profile.dir, "logins.json"))) continue;
      sources.push({
        id: `firefox:${profile.dir}`,
        browserName: "Firefox",
        profileName: profile.name,
        family: "firefox",
        cookiesPath: hasCookies ? cookiesPath : null,
        profilePath: profile.dir,
      });
    }
  }
  return sources;
}

function chromiumRoot(browser: ChromiumBrowser, env: BrowserImportEnvironment): string | null {
  if (env.platform === "darwin" && browser.macDir) {
    return path.join(env.homeDir, "Library", "Application Support", browser.macDir);
  }
  if (env.platform === "linux" && browser.linuxDir) {
    return path.join(env.homeDir, ".config", browser.linuxDir);
  }
  return null;
}

function firefoxRoots(env: BrowserImportEnvironment): string[] {
  if (env.platform === "darwin") {
    return [path.join(env.homeDir, "Library", "Application Support", "Firefox")];
  }
  if (env.platform === "linux") {
    return [
      path.join(env.homeDir, ".mozilla", "firefox"),
      path.join(env.homeDir, "snap", "firefox", "common", ".mozilla", "firefox"),
    ];
  }
  return [];
}

async function listChromiumProfiles(root: string): Promise<Array<{ dir: string; name: string }>> {
  try {
    const localState = JSON.parse(await readFile(path.join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    };
    const cache = localState.profile?.info_cache;
    if (cache && Object.keys(cache).length > 0) {
      return Object.entries(cache)
        .filter(([dir]) => dir === "Default" || /^Profile \d+$/.test(dir))
        .map(([dir, info]) => ({ dir, name: info.name || dir }));
    }
  } catch {}
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries
    .filter((entry) => entry === "Default" || /^Profile \d+$/.test(entry))
    .map((dir) => ({ dir, name: dir }));
}

async function listFirefoxProfiles(root: string): Promise<Array<{ dir: string; name: string }>> {
  const ini = await readFile(path.join(root, "profiles.ini"), "utf8").catch(() => null);
  if (!ini) return [];
  const profiles: Array<{ dir: string; name: string }> = [];
  for (const section of ini.split(/^\[/m)) {
    if (!section.startsWith("Profile")) continue;
    const fields = Object.fromEntries(
      section
        .split(/\r?\n/)
        .map((line) => line.split("="))
        .filter((parts) => parts.length >= 2)
        .map(([key, ...rest]) => [key!.trim(), rest.join("=").trim()]),
    );
    if (!fields.Path) continue;
    const dir = fields.IsRelative === "0" ? fields.Path : path.join(root, fields.Path);
    profiles.push({ dir, name: fields.Name || fields.Path });
  }
  return profiles;
}

interface SqliteStatement {
  all(): Record<string, unknown>[];
  get(): Record<string, unknown> | undefined;
  setReadBigInts(enabled: boolean): void;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

async function withDatabaseCopy<T>(
  dbPath: string,
  read: (db: SqliteDatabase) => T | Promise<T>,
): Promise<T> {
  const sqliteSpecifier: string = "node:sqlite";
  const sqlite = (await import(sqliteSpecifier)) as SqliteModule;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-cookie-import-"));
  const copyPath = path.join(tempDir, "cookies.db");
  try {
    for (const suffix of ["", "-wal", "-journal"]) {
      if (existsSync(dbPath + suffix)) await copyFile(dbPath + suffix, copyPath + suffix);
    }
    const db = new sqlite.DatabaseSync(copyPath);
    try {
      return await read(db);
    } finally {
      db.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function readAllRows(db: SqliteDatabase, sql: string): Record<string, unknown>[] {
  const statement = db.prepare(sql);

  statement.setReadBigInts(true);
  return statement.all();
}

async function readChromiumCookies(
  db: SqliteDatabase,
  browser: ChromiumBrowser,
  env: BrowserImportEnvironment,
): Promise<BrowserImportCookie[]> {
  const metaVersion = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0,
  );
  const rows = readAllRows(db, "SELECT * FROM cookies");
  const keys = await chromiumKeys(rows, browser, env);
  const cookies: BrowserImportCookie[] = [];
  let undecryptable = 0;
  for (const row of rows) {
    if (row.top_frame_site_key) continue;
    const expires =
      Number(row.has_expires) && Number(row.is_persistent)
        ? Math.min(
            Number(row.expires_utc) / 1_000_000 - CHROMIUM_EPOCH_OFFSET_SECONDS,
            MAX_COOKIE_EXPIRES_SECONDS,
          )
        : -1;
    if (expires !== -1 && expires < env.nowSeconds) continue;
    const domain = String(row.host_key);
    const encrypted = Buffer.from(row.encrypted_value as Uint8Array);
    let value = String(row.value ?? "");
    if (encrypted.length > 0) {
      const decrypted = decryptChromiumCookieValue({ encrypted, keys, domain, metaVersion });
      if (decrypted === null) {
        undecryptable += 1;
        continue;
      }
      value = decrypted;
    }
    const secure = Boolean(Number(row.is_secure));
    cookies.push({
      name: String(row.name),
      value,
      domain,
      path: String(row.path || "/"),
      expires,
      httpOnly: Boolean(Number(row.is_httponly)),
      secure,
      ...sameSiteAttribute(Number(row.samesite), secure),
    });
  }
  if (undecryptable > 0) throw new BrowserImportError(keyringHelp(browser, env.platform));
  return cookies;
}

function keyringHelp(browser: ChromiumBrowser, platform: NodeJS.Platform): string {
  const action =
    platform === "darwin"
      ? `Unlock the login keychain in Keychain Access and allow access to "${browser.macKeychainService}".`
      : "Unlock your desktop login keyring and run PandaOS in the same desktop/D-Bus session as the source browser.";
  return `${browser.name} data could not be decrypted with this device's keyring. ${action} Open the source profile once, then retry. A profile copied from another device needs its original keyring; importing other cookies does not restore its login.`;
}

export interface ChromiumKeys {
  v10: Buffer | null;
  v11: Buffer | null;
}

async function chromiumKeys(
  rows: Record<string, unknown>[],
  browser: ChromiumBrowser,
  env: BrowserImportEnvironment,
): Promise<ChromiumKeys> {
  const prefixes = new Set(
    rows.map((row) =>
      Buffer.from(row.encrypted_value as Uint8Array)
        .subarray(0, 3)
        .toString(),
    ),
  );
  if (env.platform === "darwin") {
    if (!prefixes.has("v10")) return { v10: null, v11: null };
    const password = await env.readSafeStoragePassword(browser);
    if (!password) {
      throw new BrowserImportError(keyringHelp(browser, env.platform));
    }
    return { v10: deriveChromiumKey(password, 1003), v11: null };
  }

  let v11: Buffer | null = null;
  if (prefixes.has("v11")) {
    const password = await env.readSafeStoragePassword(browser);
    if (!password) {
      throw new BrowserImportError(keyringHelp(browser, env.platform));
    }
    v11 = deriveChromiumKey(password, 1);
  }
  return { v10: deriveChromiumKey("peanuts", 1), v11 };
}

export async function readBrowserProfileEncryptionKey(): Promise<Buffer> {
  const env = defaultBrowserImportEnvironment();
  for (const browser of CHROMIUM_BROWSERS.slice(0, 2)) {
    const secret = await env.readSafeStoragePassword(browser);
    if (secret)
      return createHash("sha256").update("pandaos-browser-profile-v1\0").update(secret).digest();
  }
  throw new BrowserImportError(
    "The host browser keyring is unavailable. Unlock the login keyring and run PandaOS in the same desktop/D-Bus session as Chrome or Chromium. Open Chrome once to create its Safe Storage entry, then retry.",
  );
}

export function deriveChromiumKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

export function decryptChromiumCookieValue(input: {
  encrypted: Buffer;
  keys: ChromiumKeys;
  domain: string;
  metaVersion: number;
}): string | null {
  const prefix = input.encrypted.subarray(0, 3).toString();
  const keysByPrefix: Record<string, Buffer | null> = { v10: input.keys.v10, v11: input.keys.v11 };
  const key = keysByPrefix[prefix];
  if (!key) return null;
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, CHROMIUM_IV);
    plaintext = Buffer.concat([decipher.update(input.encrypted.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
  if (input.metaVersion >= 24) {
    const hostHash = createHash("sha256").update(input.domain).digest();
    if (plaintext.length < 32 || !plaintext.subarray(0, 32).equals(hostHash)) return null;
    plaintext = plaintext.subarray(32);
  }
  return plaintext.toString("utf8");
}

function sameSiteAttribute(value: number, secure: boolean): Pick<BrowserImportCookie, "sameSite"> {
  if (value === 2) return { sameSite: "Strict" };
  if (value === 1) return { sameSite: "Lax" };

  if (value === 0 && secure) return { sameSite: "None" };
  return {};
}

function readFirefoxCookies(db: SqliteDatabase, nowSeconds: number): BrowserImportCookie[] {
  const rows = readAllRows(db, "SELECT * FROM moz_cookies WHERE originAttributes = ''");
  return parseFirefoxCookieRows(rows, nowSeconds);
}

export function parseFirefoxCookieRows(
  rows: Record<string, unknown>[],
  nowSeconds: number,
): BrowserImportCookie[] {
  const cookies: BrowserImportCookie[] = [];
  for (const row of rows) {
    const rawExpiry = Number(row.expiry);

    const expires = Math.min(
      rawExpiry > 1e11 ? rawExpiry / 1000 : rawExpiry,
      MAX_COOKIE_EXPIRES_SECONDS,
    );
    if (expires < nowSeconds) continue;
    const secure = Boolean(Number(row.isSecure));
    cookies.push({
      name: String(row.name),
      value: String(row.value ?? ""),
      domain: String(row.host),
      path: String(row.path || "/"),
      expires,
      httpOnly: Boolean(Number(row.isHttpOnly)),
      secure,
      ...sameSiteAttribute(Number(row.sameSite), secure),
    });
  }
  return cookies;
}

async function readMacKeychainPassword(service: string): Promise<string | null> {
  try {
    const { stdout } = await execCommand(
      "security",
      ["find-generic-password", "-w", "-s", service],
      {
        timeout: 120_000,
        envMode: "internal",
      },
    );
    return String(stdout).trim() || null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;

    if (code === 44) return null;
    throw new BrowserImportError(`Keychain access to "${service}" was denied.`);
  }
}

async function readLinuxSecretPassword(application: string): Promise<string | null> {
  try {
    const { stdout } = await execCommand("secret-tool", ["lookup", "application", application], {
      timeout: 30_000,
      envMode: "internal",
    });
    return String(stdout).trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BrowserImportError(
        "Reading the Linux browser keyring needs secret-tool. Install libsecret-tools, unlock the login keyring, and run PandaOS in the same desktop/D-Bus session as the source browser.",
      );
    }
    return null;
  }
}
