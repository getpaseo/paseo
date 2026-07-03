import type { Rectangle } from "electron";
import { ipcMain } from "electron";
import { BrowserAutomationExecuteRequestSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserAutomationConsoleLogEntry } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { TabContents, BrowserRegistry, TabImage } from "./service.js";
import { executeAutomationCommand } from "./service.js";
import {
  listRegisteredPaseoBrowserIds,
  listRegisteredPaseoBrowserIdsForWorkspace,
  getPaseoBrowserWebContents,
  getWorkspaceActivePaseoBrowserId,
  getPaseoBrowserWorkspaceId,
} from "../browser-webviews/index.js";

const MAX_CONSOLE_MESSAGES_PER_TAB = 200;
const PIXEL_CAPTURE_BRIDGE_TIMEOUT_MS = 5_000;
const consoleMessagesByContentsId = new Map<number, BrowserAutomationConsoleLogEntry[]>();
const observedContentsIds = new Set<number>();
let nextPixelCaptureBridgeRequest = 0;

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

interface IpcBridgeEvent {
  sender?: {
    id?: number;
  };
}

type IpcListener = (event: IpcBridgeEvent, payload: unknown) => void;

interface IpcCaptureBridge {
  on(channel: string, listener: IpcListener): void;
  removeListener(channel: string, listener: IpcListener): void;
}

interface HostWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

interface WebContentsDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface ConsoleMessageEmitter {
  on(
    event: "console-message",
    listener: (
      event: unknown,
      level: unknown,
      message: unknown,
      line: unknown,
      sourceId: unknown,
    ) => void,
  ): void;
  once(event: "destroyed", listener: () => void): void;
}

interface BrowserAutomationWebContents extends ConsoleMessageEmitter {
  readonly id: number;
  readonly hostWebContents: HostWebContents | null;
  readonly debugger: WebContentsDebugger;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  capturePage(rect?: Rectangle, options?: { stayHidden?: boolean }): Promise<TabImage>;
  invalidate(): void;
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
}

type PixelCaptureBridgeKind = "prepare" | "restore";

interface PixelCaptureBridgeSuccess {
  token?: string;
}

interface PixelCaptureBridgeOptions {
  ipc?: IpcCaptureBridge;
  createRequestId?: () => string;
  timeoutMs?: number;
}

interface PreparedPixelCapture {
  browserId: string;
  host: HostWebContents;
}

export function adaptWebContents(
  contents: BrowserAutomationWebContents,
  browserId: string,
  options?: PixelCaptureBridgeOptions,
): TabContents {
  observeConsoleMessages(contents);
  const preparedPixelCapturesByToken = new Map<string, PreparedPixelCapture>();
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
    capturePage: (captureOptions) => contents.capturePage(undefined, captureOptions),
    prepareForPixelCapture: async () => {
      const host = getPixelCaptureHost(contents);
      const result = await requestPixelCaptureBridge({ host, browserId, kind: "prepare", options });
      if (!result.token) {
        throw new Error("Browser pixel capture preparation did not return a token.");
      }
      preparedPixelCapturesByToken.set(result.token, { browserId, host });
      return { token: result.token };
    },
    restorePixelCapture: async (preparation) => {
      const prepared = preparedPixelCapturesByToken.get(preparation.token);
      if (!prepared) {
        throw new Error("Browser pixel capture preparation is no longer active.");
      }
      try {
        await requestPixelCaptureBridge({
          host: prepared.host,
          browserId: prepared.browserId,
          kind: "restore",
          options,
          extraPayload: { token: preparation.token },
        });
      } finally {
        preparedPixelCapturesByToken.delete(preparation.token);
      }
    },
    invalidate: () => contents.invalidate(),
    isBackgroundThrottlingAllowed: () => contents.getBackgroundThrottling(),
    setBackgroundThrottling: (allowed) => contents.setBackgroundThrottling(allowed),
    getConsoleMessages: () => consoleMessagesByContentsId.get(contents.id) ?? [],
    sendDebugCommand: async (command: string, params?: Record<string, unknown>) => {
      if (!contents.debugger.isAttached()) {
        contents.debugger.attach("1.3");
      }
      return contents.debugger.sendCommand(command, params ?? {});
    },
  };
}

function getPixelCaptureHost(contents: BrowserAutomationWebContents): HostWebContents {
  const host = contents.hostWebContents;
  if (!host || host.isDestroyed()) {
    throw new Error("Browser host renderer is not available.");
  }
  return host;
}

function requestPixelCaptureBridge(input: {
  host: HostWebContents;
  browserId: string;
  kind: PixelCaptureBridgeKind;
  options: PixelCaptureBridgeOptions | undefined;
  extraPayload?: { token: string };
}): Promise<PixelCaptureBridgeSuccess> {
  const { host, browserId, kind, options, extraPayload } = input;
  if (host.isDestroyed()) {
    return Promise.reject(new Error("Browser host renderer is not available."));
  }

  const ipc = options?.ipc ?? ipcMain;
  const requestId =
    options?.createRequestId?.() ?? `browser-pixel-capture-${++nextPixelCaptureBridgeRequest}`;
  const timeoutMs = options?.timeoutMs ?? PIXEL_CAPTURE_BRIDGE_TIMEOUT_MS;
  const requestChannel =
    kind === "prepare" ? "paseo:browser:capture-prepare" : "paseo:browser:capture-restore";
  const responseChannel =
    kind === "prepare" ? "paseo:browser:capture-prepared" : "paseo:browser:capture-restored";

  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      ipc.removeListener(responseChannel, listener);
    };
    const listener: IpcListener = (event, payload) => {
      if (readSenderId(event) !== host.id) {
        return;
      }
      const response = readPixelCaptureBridgeResponse(payload, requestId);
      if (!response) {
        return;
      }
      cleanup();
      if (response.ok) {
        resolve(response);
      } else {
        reject(new Error(response.message));
      }
    };

    ipc.on(responseChannel, listener);
    timeoutId = setTimeout(() => {
      cleanup();
      sendPixelCaptureCancel(host, {
        requestId,
        browserId,
        ...(extraPayload ? { token: extraPayload.token } : {}),
      });
      reject(new Error(`Browser pixel capture ${kind} timed out.`));
    }, timeoutMs);

    try {
      host.send(requestChannel, {
        requestId,
        browserId,
        ...(extraPayload ? { token: extraPayload.token } : {}),
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function sendPixelCaptureCancel(
  host: HostWebContents,
  payload: { browserId: string; requestId?: string; token?: string },
): void {
  if (host.isDestroyed()) {
    return;
  }
  try {
    host.send("paseo:browser:capture-cancel", payload);
  } catch {
    // The original prepare/restore request owns the user-visible error.
  }
}

function readSenderId(event: IpcBridgeEvent): number | null {
  const senderId = event.sender?.id;
  return typeof senderId === "number" ? senderId : null;
}

function readPixelCaptureBridgeResponse(
  payload: unknown,
  requestId: string,
): ({ ok: true } & PixelCaptureBridgeSuccess) | { ok: false; message: string } | null {
  if (!isRecord(payload)) {
    return null;
  }
  const record = payload;
  if (record.requestId !== requestId) {
    return null;
  }
  if (record.ok === true) {
    return {
      ok: true,
      ...(typeof record.token === "string" && record.token.length > 0
        ? { token: record.token }
        : {}),
    };
  }
  if (record.ok === false) {
    const message =
      typeof record.message === "string" && record.message.length > 0
        ? record.message
        : "Browser pixel capture bridge failed.";
    return { ok: false, message };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observeConsoleMessages(contents: BrowserAutomationWebContents): void {
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
      return contents ? adaptWebContents(contents, browserId) : null;
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
