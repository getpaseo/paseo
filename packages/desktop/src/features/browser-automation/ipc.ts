import { ipcMain, nativeImage } from "electron";
import { BrowserAutomationExecuteRequestSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type {
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationDialogEvent,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { TabContents, BrowserRegistry, TabImage } from "./service.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { CdpSessionQueue } from "./cdp-session-queue.js";
import {
  dialogAcceptValue,
  handledDialogEvent,
  MAX_DIALOGS_PER_COMMAND,
  promptShimDrainScript,
  promptShimInstallScript,
  promptShimRestoreScript,
} from "./dialog-handling.js";
import { BrowserTabClosedError, executeAutomationCommand } from "./service.js";
import { BrowserSnapshotEngine } from "./snapshot-engine.js";
import {
  listRegisteredPaseoBrowserIds,
  listRegisteredPaseoBrowserIdsForWorkspace,
  getPaseoBrowserWebContentsForHostWindow,
  getWorkspaceActivePaseoBrowserIdForHostWindow,
  getPaseoBrowserWorkspaceId,
} from "../browser-webviews/index.js";

const MAX_CONSOLE_MESSAGES_PER_TAB = 200;
const consoleMessagesByContentsId = new Map<number, BrowserAutomationConsoleLogEntry[]>();
const cdpQueuesByContentsId = new Map<number, CdpSessionQueue>();
const dialogMonitorsByContentsId = new Map<number, DialogMonitor>();
const observedContentsIds = new Set<number>();

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

interface HostWebContents {
  readonly id: number;
  once(event: "destroyed", listener: () => void): void;
}

export class HostSnapshotEngineRegistry {
  private readonly entries = new Map<
    number,
    { hostContents: HostWebContents; snapshotEngine: BrowserSnapshotEngine }
  >();

  public get(hostContents: HostWebContents): BrowserSnapshotEngine {
    const existing = this.entries.get(hostContents.id);
    if (existing) {
      return existing.snapshotEngine;
    }
    const snapshotEngine = new BrowserSnapshotEngine();
    const entry = { hostContents, snapshotEngine };
    this.entries.set(hostContents.id, entry);
    hostContents.once("destroyed", () => {
      if (this.entries.get(hostContents.id) === entry) {
        this.entries.delete(hostContents.id);
      }
    });
    return snapshotEngine;
  }
}

const hostSnapshotEngines = new HostSnapshotEngineRegistry();

interface WebContentsDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  on?(
    event: "message",
    listener: (event: unknown, method: string, params?: Record<string, unknown>) => void,
  ): void;
  on?(event: "detach", listener: () => void): void;
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
  removeListener(event: "destroyed", listener: () => void): void;
  readonly id: number;
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
  sendInputEvent(event: IsolatedKeyboardInputEvent): void;
  insertText(text: string): Promise<void>;
}

export function adaptWebContents(contents: BrowserAutomationWebContents): TabContents {
  const contentsId = contents.id;
  observeConsoleMessages(contents, contentsId);
  const cdpQueue = getCdpQueue(contentsId);
  const dialogMonitor = getDialogMonitor(contents, contentsId, cdpQueue);
  return {
    id: contentsId,
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
    captureFrame: (signal) => cdpQueue.run(() => captureViewportFrame(contents, signal)),
    sendInputEvent: (event) => contents.sendInputEvent(event),
    insertText: (text) => contents.insertText(text),
    getConsoleMessages: () => consoleMessagesByContentsId.get(contentsId) ?? [],
    captureDialogs: (task) => dialogMonitor.capture(task),
    sendDebugCommand: (command: string, params?: Record<string, unknown>) =>
      cdpQueue.run(async () => {
        if (!contents.debugger.isAttached()) {
          contents.debugger.attach("1.3");
        }
        if (command === "Page.captureScreenshot")
          return withCaptureFrameProduction(contents, AbortSignal.timeout(5_000), () =>
            contents.debugger.sendCommand(command, params ?? {}),
          );
        return contents.debugger.sendCommand(command, params ?? {});
      }),
  };
}

function captureViewportFrame(
  contents: BrowserAutomationWebContents,
  signal: AbortSignal,
): Promise<TabImage> {
  return withCaptureFrameProduction(contents, signal, async () => {
    const result = await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: "({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })",
      returnByValue: true,
    });
    signal.throwIfAborted();
    if (contents.isDestroyed()) throw new BrowserTabClosedError();
    const metrics = result as {
      result?: { value?: { x: number; y: number; width: number; height: number } };
    };
    // innerWidth includes the scrollbar gutter; CDP layout metrics omit it.
    const viewport = metrics.result?.value;
    if (!viewport || viewport.width <= 0 || viewport.height <= 0)
      throw new Error("No frame returned by viewport capture");
    const response = await contents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { ...viewport, scale: 1 },
    });
    signal.throwIfAborted();
    const data = (response as { data?: string }).data;
    if (!data) throw new Error("No frame returned by viewport capture");
    const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
    if (image.isEmpty()) throw new Error("No frame returned by viewport capture");
    return image;
  });
}

function withCaptureFrameProduction<T>(
  contents: BrowserAutomationWebContents,
  signal: AbortSignal,
  capture: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (contents.isDestroyed()) return Promise.reject(new BrowserTabClosedError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let screencastRequested = false;
    const stop = async () => {
      settled = true;
      signal.removeEventListener("abort", abort);
      contents.removeListener("destroyed", destroyed);
      if (screencastRequested) {
        screencastRequested = false;
        await contents.debugger.sendCommand("Page.stopScreencast");
      }
    };
    const fail = async (error: unknown) => {
      if (settled) return;
      try {
        await stop();
      } catch {
        /* Preserve the capture or cancellation error. */
      }
      reject(error);
    };
    const abort = () => {
      void fail(signal.reason);
    };
    const destroyed = () => {
      void fail(new BrowserTabClosedError());
    };
    signal.addEventListener("abort", abort, { once: true });
    contents.once("destroyed", destroyed);
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      // The CDP video consumer makes hidden Linux surfaces paintable. Stop it on
      // every exit so captures do not leave the page producing background frames.
      // Native capture and Electron's throttling setter cannot be canceled safely.
      screencastRequested = true;
      void contents.debugger
        .sendCommand("Page.startScreencast", { format: "png", maxWidth: 1, maxHeight: 1 })
        .then(() => {
          if (settled) throw signal.reason ?? new BrowserTabClosedError();
          signal.throwIfAborted();
          return capture();
        })
        .then(async (result) => {
          if (settled) return null;
          try {
            await stop();
            resolve(result);
          } catch (error) {
            reject(error);
          }
          return null;
        })
        .catch(fail);
    } catch (error) {
      void fail(error);
    }
  });
}

function getCdpQueue(contentsId: number): CdpSessionQueue {
  const existing = cdpQueuesByContentsId.get(contentsId);
  if (existing) {
    return existing;
  }
  const queue = new CdpSessionQueue();
  cdpQueuesByContentsId.set(contentsId, queue);
  return queue;
}

function observeConsoleMessages(contents: BrowserAutomationWebContents, contentsId: number): void {
  if (observedContentsIds.has(contentsId)) {
    return;
  }
  observedContentsIds.add(contentsId);
  contents.on("console-message", (_event, level, message, line, sourceId) => {
    const entry = normalizeConsoleMessage({ level, message, line, sourceId });
    const messages = consoleMessagesByContentsId.get(contentsId) ?? [];
    messages.push(entry);
    consoleMessagesByContentsId.set(contentsId, messages.slice(-MAX_CONSOLE_MESSAGES_PER_TAB));
  });
  contents.once("destroyed", () => {
    observedContentsIds.delete(contentsId);
    consoleMessagesByContentsId.delete(contentsId);
    cdpQueuesByContentsId.delete(contentsId);
    dialogMonitorsByContentsId.delete(contentsId);
  });
}

function getDialogMonitor(
  contents: BrowserAutomationWebContents,
  contentsId: number,
  cdpQueue: CdpSessionQueue,
): DialogMonitor {
  const existing = dialogMonitorsByContentsId.get(contentsId);
  if (existing) {
    return existing;
  }
  const monitor = new DialogMonitor(contents, contentsId, cdpQueue);
  dialogMonitorsByContentsId.set(contentsId, monitor);
  return monitor;
}

class DialogMonitor {
  private enabled = false;
  private listenerRegistered = false;
  private detachGeneration = 0;
  private readonly activeCollectors: DialogCollector[] = [];

  public constructor(
    private readonly contents: BrowserAutomationWebContents,
    private readonly contentsId: number,
    private readonly cdpQueue: CdpSessionQueue,
  ) {}

  public async capture<T>(
    task: () => Promise<T>,
  ): Promise<{ result: T; dialogs: BrowserAutomationDialogEvent[] }> {
    const collector: DialogCollector = { dialogs: [] };
    const setupDetachGeneration = this.detachGeneration;
    try {
      await this.enable();
      await this.installPromptShim();
    } catch (error) {
      if (this.contents.isDestroyed() || this.detachGeneration !== setupDetachGeneration) {
        throw error;
      }
      console.warn("[browser-automation] Dialog capture unavailable; running command without it", {
        contentsId: this.contentsId,
        error,
      });
      return { result: await task(), dialogs: [] };
    }
    this.activeCollectors.push(collector);
    try {
      const result = await task();
      this.recordPromptShimDialogs(await this.drainPromptShim());
      return { result, dialogs: collector.dialogs };
    } finally {
      const index = this.activeCollectors.indexOf(collector);
      if (index >= 0) {
        this.activeCollectors.splice(index, 1);
      }
      if (this.activeCollectors.length === 0) {
        await this.restorePromptShim();
      }
    }
  }

  private async enable(): Promise<void> {
    if (this.enabled) {
      return;
    }
    if (!this.contents.debugger.on) {
      return;
    }
    if (!this.listenerRegistered) {
      this.listenerRegistered = true;
      this.contents.debugger.on("message", (_event, method, params) => {
        if (method !== "Page.javascriptDialogOpening") {
          return;
        }
        if (this.activeCollectors.length === 0) {
          return;
        }
        void this.handleOpening(params ?? {});
      });
      this.contents.debugger.on("detach", () => {
        this.enabled = false;
        this.detachGeneration += 1;
      });
    }
    await this.sendDebugCommand("Page.enable");
    this.enabled = true;
  }

  private async handleOpening(params: Record<string, unknown>): Promise<void> {
    const event = handledDialogEvent(params);
    for (const collector of this.activeCollectors) {
      this.recordDialogs(collector, [event]);
    }
    await this.sendDialogResponseCommand("Page.handleJavaScriptDialog", {
      accept: dialogAcceptValue(event.type),
    });
  }

  private async installPromptShim(): Promise<void> {
    await this.sendDebugCommand("Runtime.evaluate", {
      expression: promptShimInstallScript(),
      returnByValue: true,
    });
  }

  private async drainPromptShim(): Promise<BrowserAutomationDialogEvent[]> {
    try {
      const result = (await this.sendDebugCommand("Runtime.evaluate", {
        expression: promptShimDrainScript(),
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      return parsePromptShimDialogs(result.result?.value);
    } catch {
      return [];
    }
  }

  private async restorePromptShim(): Promise<void> {
    try {
      await this.sendDebugCommand("Runtime.evaluate", {
        expression: promptShimRestoreScript(),
        returnByValue: true,
      });
    } catch {
      // Navigation can destroy the execution context before cleanup runs; the next page has no shim.
    }
  }

  private recordDialogs(collector: DialogCollector, dialogs: BrowserAutomationDialogEvent[]): void {
    for (const dialog of dialogs) {
      if (collector.dialogs.length >= MAX_DIALOGS_PER_COMMAND) {
        return;
      }
      collector.dialogs.push(dialog);
    }
  }

  private recordPromptShimDialogs(dialogs: BrowserAutomationDialogEvent[]): void {
    for (const collector of this.activeCollectors) {
      this.recordDialogs(collector, dialogs);
    }
  }

  private async sendDebugCommand(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.cdpQueue.run(async () => {
      if (!this.contents.debugger.isAttached()) {
        this.contents.debugger.attach("1.3");
      }
      return this.contents.debugger.sendCommand(command, params ?? {});
    });
  }

  private async sendDialogResponseCommand(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    // Dialogs can block the CDP command that opened them, so the unblocker must not wait behind
    // the per-tab command queue.
    if (!this.contents.debugger.isAttached()) {
      this.contents.debugger.attach("1.3");
    }
    return this.contents.debugger.sendCommand(command, params ?? {});
  }
}

interface DialogCollector {
  dialogs: BrowserAutomationDialogEvent[];
}

function parsePromptShimDialogs(value: unknown): BrowserAutomationDialogEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): BrowserAutomationDialogEvent[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (record.type !== "prompt" || record.action !== "dismissed") {
      return [];
    }
    return [
      {
        type: "prompt",
        message: typeof record.message === "string" ? record.message : "",
        ...(typeof record.defaultValue === "string" ? { defaultValue: record.defaultValue } : {}),
        action: "dismissed",
        timestamp: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
      },
    ];
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

function createRegistry(hostWebContentsId: number): BrowserRegistry {
  return {
    listRegisteredBrowserIds: listRegisteredPaseoBrowserIds,
    listRegisteredBrowserIdsForWorkspace: listRegisteredPaseoBrowserIdsForWorkspace,
    getTabContents(browserId: string): TabContents | null {
      const contents = getPaseoBrowserWebContentsForHostWindow(browserId, hostWebContentsId);
      return contents ? adaptWebContents(contents) : null;
    },
    getBrowserWorkspaceId: getPaseoBrowserWorkspaceId,
    getWorkspaceActiveBrowserId(workspaceId: string): string | null {
      return getWorkspaceActivePaseoBrowserIdForHostWindow(workspaceId, hostWebContentsId);
    },
  };
}

export function registerBrowserAutomationIpc(options?: { ipc?: IpcHandlerRegistry }): void {
  const ipc = options?.ipc ?? ipcMain;

  ipc.handle("paseo:browser:execute-automation-command", async (event, rawRequest: unknown) => {
    const hostContents = (event as { sender?: HostWebContents }).sender;
    const hostWebContentsId = hostContents?.id;
    if (!hostContents || typeof hostWebContentsId !== "number") {
      return {
        requestId: readRequestId(rawRequest),
        ok: false as const,
        error: {
          code: "browser_unsupported" as const,
          message: "Browser automation requires a host window.",
        },
      };
    }
    const registry = createRegistry(hostWebContentsId);
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
    return executeAutomationCommand(parsed.data, registry, {
      snapshotEngine: hostSnapshotEngines.get(hostContents),
    });
  });
}

function readRequestId(rawRequest: unknown): string {
  if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
    return "unknown";
  }
  const requestId = (rawRequest as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : "unknown";
}
