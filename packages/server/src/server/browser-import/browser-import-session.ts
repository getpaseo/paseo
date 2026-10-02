import type {
  BrowserProfileBackupRequest,
  BrowserProfilePasswordsRequest,
  BrowserImportCookiesRequest,
  BrowserImportListSourcesRequest,
} from "@getpaseo/protocol/browser-import/rpc-schemas";
import type { SessionOutboundMessage } from "../messages.js";
import type { DaemonPlaywrightHost } from "../verify/playwright-host.js";
import {
  BrowserImportError,
  listBrowserImportSources,
  readBrowserImportCookies,
  readBrowserImportPasswords,
} from "./browser-cookie-import.js";

interface BrowserImportSessionDeps {
  host: DaemonPlaywrightHost | null | undefined;
  emit: (message: SessionOutboundMessage) => void;
}

export async function handleBrowserImportListSources(
  request: BrowserImportListSourcesRequest,
  deps: BrowserImportSessionDeps,
): Promise<void> {
  try {
    const sources = await listBrowserImportSources();
    deps.emit({
      type: "browser.import.list_sources.response",
      payload: { requestId: request.requestId, sources, error: null },
    });
  } catch (error) {
    deps.emit({
      type: "browser.import.list_sources.response",
      payload: { requestId: request.requestId, sources: [], error: errorMessage(error) },
    });
  }
}

export async function handleBrowserImportCookies(
  request: BrowserImportCookiesRequest,
  deps: BrowserImportSessionDeps,
): Promise<void> {
  try {
    if (!deps.host) {
      throw new BrowserImportError("The Paseo browser is unavailable on this daemon.");
    }
    const cookies =
      request.source.kind === "host"
        ? await readBrowserImportCookies(request.source.sourceId)
        : request.source.cookies;
    let logins = request.source.kind === "cookies" ? (request.source.logins ?? []) : [];
    if (request.source.kind === "host" && request.source.includePasswords) {
      logins = await readBrowserImportPasswords(
        request.source.sourceId,
        undefined,
        request.source.primaryPassword ?? "",
      );
    }
    const result = await deps.host.importProfile(cookies, logins);
    deps.emit({
      type: "browser.import.import_cookies.response",
      payload: { requestId: request.requestId, ...result, error: null },
    });
  } catch (error) {
    deps.emit({
      type: "browser.import.import_cookies.response",
      payload: {
        requestId: request.requestId,
        cookieCount: 0,
        domainCount: 0,
        error: errorMessage(error),
      },
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof BrowserImportError ? error.message : "Browser import failed.";
}

export async function handleBrowserProfileBackup(
  request: BrowserProfileBackupRequest,
  deps: BrowserImportSessionDeps,
): Promise<void> {
  const empty = { cookieCount: 0, passwordCount: 0, skippedCookies: 0, skippedPasswords: 0 };
  try {
    if (!deps.host) throw new BrowserImportError("The host browser is unavailable.");
    const result = await deps.host.backupProfile(request);
    deps.emit({
      type: "browser.profile.backup.response",
      payload: { requestId: request.requestId, error: null, ...result },
    });
  } catch (error) {
    const { BrowserBackupError } = await import("./browser-backup.js");
    deps.emit({
      type: "browser.profile.backup.response",
      payload: {
        requestId: request.requestId,
        ...empty,
        error:
          error instanceof BrowserBackupError || error instanceof BrowserImportError
            ? error.message
            : "Host browser backup failed. Existing profile data was preserved; unlock the host keyring and retry.",
      },
    });
  }
}

export async function handleBrowserProfilePasswords(
  request: BrowserProfilePasswordsRequest,
  deps: BrowserImportSessionDeps,
): Promise<void> {
  try {
    if (!deps.host) throw new BrowserImportError("The host browser is unavailable.");
    const logins = await deps.host.manageSavedPasswords(request);
    deps.emit({
      type: "browser.profile.manage_passwords.response",
      payload: { requestId: request.requestId, available: true, logins, error: null },
    });
  } catch (error) {
    deps.emit({
      type: "browser.profile.manage_passwords.response",
      payload: {
        requestId: request.requestId,
        available: false,
        logins: [],
        error: errorMessage(error),
      },
    });
  }
}
