import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { WebContents } from "electron";
import { ipcMain } from "electron";
import { BrowserAutomationExecuteRequestSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type {
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationCookieEntry,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { TabContents, BrowserRegistry } from "./service.js";
import { executeAutomationCommand } from "./service.js";
import {
  listRegisteredPaseoBrowserIds,
  listRegisteredPaseoBrowserIdsForWorkspace,
  getPaseoBrowserWebContents,
  getWorkspaceActivePaseoBrowserId,
  getPaseoBrowserWorkspaceId,
} from "../browser-webviews/index.js";

const MAX_CONSOLE_MESSAGES_PER_TAB = 200;
const consoleMessagesByContentsId = new Map<number, BrowserAutomationConsoleLogEntry[]>();
const observedContentsIds = new Set<number>();

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

function adaptWebContents(contents: WebContents): TabContents {
  observeConsoleMessages(contents);
  return {
    id: contents.id,
    getURL: () => contents.getURL(),
    getTitle: () => contents.getTitle(),
    canGoBack: () => contents.canGoBack(),
    canGoForward: () => contents.canGoForward(),
    isLoading: () => contents.isLoading(),
    isDestroyed: () => contents.isDestroyed(),
    executeJavaScript: (code: string) => contents.executeJavaScript(code),
    loadURL: (url: string) => contents.loadURL(url),
    goBack: () => contents.goBack(),
    goForward: () => contents.goForward(),
    reload: () => contents.reload(),
    capturePage: (options) => contents.capturePage(undefined, options),
    invalidate: () => contents.invalidate(),
    isBackgroundThrottlingAllowed: () => contents.getBackgroundThrottling(),
    setBackgroundThrottling: (allowed) => contents.setBackgroundThrottling(allowed),
    getConsoleMessages: () => consoleMessagesByContentsId.get(contents.id) ?? [],
    getCookies: async (url: string) =>
      (await contents.session.cookies.get({ url })).map(normalizeCookie),
    sendDebugCommand: async (command: string, params?: Record<string, unknown>) => {
      if (!contents.debugger.isAttached()) {
        contents.debugger.attach("1.3");
      }
      return contents.debugger.sendCommand(command, params ?? {});
    },
    printToPDF: async (options?: Record<string, unknown>) => contents.printToPDF(options ?? {}),
    downloadURL: (input) => downloadWithContents(contents, input),
  };
}

function downloadWithContents(
  contents: WebContents,
  input: { url: string; fileName?: string },
): Promise<{ filePath: string; totalBytes?: number; state: string }> {
  const downloadDir = join(tmpdir(), "paseo-browser-downloads");
  mkdirSync(downloadDir, { recursive: true });
  const filePath = join(downloadDir, sanitizeDownloadFileName(input));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      contents.session.off("will-download", onDownload);
      reject(new Error(`Timed out waiting for browser download: ${input.url}`));
    }, 30_000);
    function onDownload(_event: Electron.Event, item: Electron.DownloadItem): void {
      if (item.getURL() !== input.url) {
        return;
      }
      clearTimeout(timeout);
      contents.session.off("will-download", onDownload);
      item.setSavePath(filePath);
      item.once("done", (_doneEvent, state) => {
        resolve({ filePath, totalBytes: item.getTotalBytes(), state });
      });
    }
    contents.session.on("will-download", onDownload);
    contents.downloadURL(input.url);
  });
}

export function sanitizeDownloadFileName(input: { url: string; fileName?: string }): string {
  const requestedName = input.fileName ?? basename(new URL(input.url).pathname);
  return basename(requestedName) || "download";
}

function normalizeCookie(cookie: Electron.Cookie): BrowserAutomationCookieEntry {
  return {
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain ? { domain: cookie.domain } : {}),
    ...(cookie.path ? { path: cookie.path } : {}),
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(typeof cookie.expirationDate === "number" ? { expirationDate: cookie.expirationDate } : {}),
  };
}

function observeConsoleMessages(contents: WebContents): void {
  if (observedContentsIds.has(contents.id)) {
    return;
  }
  observedContentsIds.add(contents.id);
  contents.on("console-message", (_event, level, message, line, sourceId) => {
    const entry = normalizeConsoleMessage({ level, message, line, sourceId });
    const messages = consoleMessagesByContentsId.get(contents.id) ?? [];
    messages.push(entry);
    consoleMessagesByContentsId.set(contents.id, messages.slice(-MAX_CONSOLE_MESSAGES_PER_TAB));
  });
  contents.once("destroyed", () => {
    observedContentsIds.delete(contents.id);
    consoleMessagesByContentsId.delete(contents.id);
  });
}

function normalizeConsoleMessage(input: {
  level: unknown;
  message: unknown;
  line: unknown;
  sourceId: unknown;
}): BrowserAutomationConsoleLogEntry {
  return {
    level: typeof input.level === "string" ? input.level : String(input.level ?? "log"),
    message: typeof input.message === "string" ? input.message : String(input.message ?? ""),
    ...(typeof input.sourceId === "string" && input.sourceId.length > 0
      ? { source: input.sourceId }
      : {}),
    ...(typeof input.line === "number" ? { line: input.line } : {}),
    timestamp: Date.now(),
  };
}

function createRegistry(): BrowserRegistry {
  return {
    listRegisteredBrowserIds: listRegisteredPaseoBrowserIds,
    listRegisteredBrowserIdsForWorkspace: listRegisteredPaseoBrowserIdsForWorkspace,
    getTabContents(browserId: string): TabContents | null {
      const contents = getPaseoBrowserWebContents(browserId);
      return contents ? adaptWebContents(contents) : null;
    },
    getBrowserWorkspaceId: getPaseoBrowserWorkspaceId,
    getWorkspaceActiveBrowserId: getWorkspaceActivePaseoBrowserId,
  };
}

export function registerBrowserAutomationIpc(options?: { ipc?: IpcHandlerRegistry }): void {
  const ipc = options?.ipc ?? ipcMain;
  const registry = createRegistry();

  ipc.handle("paseo:browser:execute-automation-command", async (_event, rawRequest: unknown) => {
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      return {
        requestId: readRequestId(rawRequest),
        ok: false as const,
        error: {
          code: "browser_unsupported" as const,
          message: `Invalid automation request: ${parsed.error.message}`,
          retryable: false,
        },
      };
    }
    return executeAutomationCommand(parsed.data, registry);
  });
}

function readRequestId(rawRequest: unknown): string {
  if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
    return "unknown";
  }
  const requestId = (rawRequest as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : "unknown";
}
