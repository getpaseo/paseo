import {
  BrowserImportError,
  readBrowserImportCookies,
  readBrowserImportPasswords,
  type BrowserImportCookie,
} from "@getpaseo/server/browser-import";
import type { PasswordVault } from "./browser-passwords/vault.js";

export type ReadImportCookiesResult =
  | { ok: true; cookies: BrowserImportCookie[] }
  | { ok: false; error: string };

interface ElectronCookieDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

interface ElectronCookies {
  set(details: ElectronCookieDetails): Promise<void>;
}

export function fromElectronCookie(cookie: Electron.Cookie): BrowserImportCookie {
  const sameSite = { strict: "Strict", lax: "Lax", no_restriction: "None" } as const;
  const domain = cookie.hostOnly ? (cookie.domain ?? "").replace(/^\./, "") : (cookie.domain ?? "");
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: cookie.path ?? "/",
    expires: cookie.expirationDate ?? -1,
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? false,
    ...(cookie.sameSite && cookie.sameSite in sameSite
      ? { sameSite: sameSite[cookie.sameSite as keyof typeof sameSite] }
      : {}),
  };
}

export async function importBrowserProfile(input: {
  sourceId: string;
  primaryPassword: string;
  cookies: ElectronCookies;
  vault: PasswordVault;
}): Promise<{
  cookieCount: number;
  domainCount: number;
  passwordCount: number;
  skippedPasswords: number;
}> {
  if (!input.vault.isAvailable())
    throw new BrowserImportError("Unlock the system keychain before importing browser logins.");

  const cookies = await readBrowserImportCookies(input.sourceId);
  const logins = await readBrowserImportPasswords(input.sourceId, undefined, input.primaryPassword);
  for (const cookie of cookies) {
    try {
      await input.cookies.set(toElectronCookie(cookie));
    } catch {
      throw new BrowserImportError(
        "A cookie was rejected by the desktop browser. Some cookies may have been imported; passwords were not changed. Close the source browser and retry.",
      );
    }
  }
  const result = input.vault.importLogins(logins);
  return {
    cookieCount: cookies.length,
    domainCount: new Set(cookies.map((cookie) => cookie.domain.replace(/^\./, ""))).size,
    ...result,
  };
}

const ELECTRON_SAME_SITE = {
  Strict: "strict",
  Lax: "lax",
  None: "no_restriction",
} as const;

export function toElectronCookie(cookie: BrowserImportCookie): ElectronCookieDetails {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,

    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expires === -1 ? {} : { expirationDate: cookie.expires }),
    sameSite: cookie.sameSite ? ELECTRON_SAME_SITE[cookie.sameSite] : "unspecified",
  };
}

export async function readImportCookiesIntoSession(input: {
  sourceId: unknown;
  cookies: ElectronCookies;
}): Promise<ReadImportCookiesResult> {
  if (typeof input.sourceId !== "string") {
    return { ok: false, error: "Invalid browser profile." };
  }
  let cookies: BrowserImportCookie[];
  try {
    cookies = await readBrowserImportCookies(input.sourceId);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof BrowserImportError ? error.message : "Browser import failed.",
    };
  }
  try {
    for (const cookie of cookies) await input.cookies.set(toElectronCookie(cookie));
  } catch {
    return { ok: false, error: "A cookie was rejected by the desktop browser. Retry the import." };
  }
  return { ok: true, cookies };
}
