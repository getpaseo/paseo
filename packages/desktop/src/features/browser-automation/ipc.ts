import { ipcMain } from "electron";
import { BrowserAutomationExecuteRequestSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type {
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationDialogEvent,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { TabContents, BrowserRegistry, TabImage, DialogCaptureOperation } from "./service.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { waitForInput } from "./input-lifetime.js";
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
const inputQueuesByContentsId = new Map<number, CdpSessionQueue>();
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
  beginFrameSubscription(onlyDirty: boolean, callback: (image: TabImage) => void): void;
  endFrameSubscription(): void;
  invalidate(): void;
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
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
    captureFrame: (signal) => captureViewportFrame(contents, signal),
    invalidate: () => contents.invalidate(),
    runInput: (task, signal) =>
      getCommandQueue(contentsId, inputQueuesByContentsId).run(task, signal),
    withFrameProduction: (capture) => withGuestFrameProduction(contents, capture),
    sendInputEvent: (event) => contents.sendInputEvent(event),
    insertText: (text) => contents.insertText(text),
    getConsoleMessages: () => consoleMessagesByContentsId.get(contentsId) ?? [],
    captureDialogs: (operation) => dialogMonitor.capture(operation),
    sendDebugCommand: (command: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
      const send = async () => {
        if (!contents.debugger.isAttached()) {
          contents.debugger.attach("1.3");
        }
        return contents.debugger.sendCommand(command, params ?? {});
      };
      // Like dialog responses, cancellation cleanup must unblock a possibly
      // delivered press even when its acknowledgment still owns the queue.
      if (
        signal?.aborted &&
        command === "Input.dispatchMouseEvent" &&
        params?.type === "mouseReleased"
      ) {
        return send();
      }
      return cdpQueue.run(send, signal);
    },
  };
}

function captureViewportFrame(
  contents: BrowserAutomationWebContents,
  signal: AbortSignal,
): Promise<TabImage> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", abort);
      contents.removeListener("destroyed", destroyed);
      if (!contents.isDestroyed()) contents.endFrameSubscription();
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    const destroyed = () => {
      stop();
      reject(new BrowserTabClosedError());
    };
    signal.addEventListener("abort", abort, { once: true });
    contents.once("destroyed", destroyed);
    try {
      // A resized resident guest can paint while capturePage's surface-copy
      // request remains pending. Subscribe to its rendered frames instead.
      contents.beginFrameSubscription(false, (image) => {
        stop();
        resolve(image);
      });
    } catch (error) {
      stop();
      reject(error);
    }
  });
}

function getCdpQueue(contentsId: number): CdpSessionQueue {
  return getCommandQueue(contentsId, cdpQueuesByContentsId);
}

/** Keep input gestures atomic while still allowing screenshot activity to overlap. */
function getCommandQueue(
  contentsId: number,
  queues: Map<number, CdpSessionQueue>,
): CdpSessionQueue {
  const existing = queues.get(contentsId);
  if (existing) {
    return existing;
  }
  const queue = new CdpSessionQueue();
  queues.set(contentsId, queue);
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
    inputQueuesByContentsId.delete(contentsId);
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

  /** Release dialog ownership on cancellation even if an input acknowledgment
   * is still pending. Cleanup bypasses that request's protocol queue barrier.
   */
  public async capture<T>({
    task,
    signal,
  }: DialogCaptureOperation<T>): Promise<{ result: T; dialogs: BrowserAutomationDialogEvent[] }> {
    const collector: DialogCollector = { dialogs: [] };
    const setupDetachGeneration = this.detachGeneration;

    function waitForPhase<Value>(phase: () => Promise<Value>): Promise<Value> {
      if (signal) return waitForInput(signal, phase);
      return phase();
    }

    try {
      try {
        await waitForPhase(() => this.enable(signal));
        signal?.throwIfAborted();
        await waitForPhase(() => this.installPromptShim({ collector, signal }));
      } catch (error) {
        const cancelled = signal?.aborted === true;
        const targetLost =
          this.contents.isDestroyed() || this.detachGeneration !== setupDetachGeneration;
        if (cancelled || targetLost) throw error;
        console.warn(
          "[browser-automation] Dialog capture unavailable; running command without it",
          {
            contentsId: this.contentsId,
            error,
          },
        );
        await this.releaseCollector(collector);
        return { result: await waitForPhase(task), dialogs: [] };
      }
      const result = await waitForPhase(task);
      this.recordPromptShimDialogs(await waitForPhase(() => this.drainPromptShim(signal)));
      return { result, dialogs: collector.dialogs };
    } finally {
      await this.releaseCollector(collector);
    }
  }

  /** Remove only this command's ownership; a late completion cannot restore a
   * shim still owned by a different capture or repeat already-finished cleanup.
   */
  private async releaseCollector(collector: DialogCollector): Promise<void> {
    const index = this.activeCollectors.indexOf(collector);
    if (index < 0) return;
    this.activeCollectors.splice(index, 1);
    if (this.activeCollectors.length === 0) await this.restorePromptShim();
  }

  private async enable(signal?: AbortSignal): Promise<void> {
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
    await this.sendDebugCommand({ command: "Page.enable", signal });
    this.enabled = true;
  }

  private async handleOpening(params: Record<string, unknown>): Promise<void> {
    const event = handledDialogEvent(params);
    for (const collector of this.activeCollectors) {
      this.recordDialogs(collector, [event]);
    }
    await this.sendDialogCleanupCommand("Page.handleJavaScriptDialog", {
      accept: dialogAcceptValue(event.type),
    });
  }

  private async installPromptShim({ collector, signal }: PromptShimOwner): Promise<void> {
    await this.sendDebugCommand({
      command: "Runtime.evaluate",
      signal,
      // A waiter behind a stalled command has not installed anything. It must
      // not prolong interception owned by the command that just timed out.
      onDispatch: () => this.activeCollectors.push(collector),
      params: {
        expression: promptShimInstallScript(),
        returnByValue: true,
      },
    });
  }

  private async drainPromptShim(signal?: AbortSignal): Promise<BrowserAutomationDialogEvent[]> {
    try {
      const result = (await this.sendDebugCommand({
        command: "Runtime.evaluate",
        signal,
        params: {
          expression: promptShimDrainScript(),
          returnByValue: true,
        },
      })) as { result?: { value?: unknown } };
      return parsePromptShimDialogs(result.result?.value);
    } catch {
      return [];
    }
  }

  private async restorePromptShim(): Promise<void> {
    try {
      await this.sendDialogCleanupCommand("Runtime.evaluate", {
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

  private async sendDebugCommand({
    command,
    params,
    signal,
    onDispatch,
  }: DialogDebugCommand): Promise<unknown> {
    return this.cdpQueue.run(async () => {
      if (!this.contents.debugger.isAttached()) {
        this.contents.debugger.attach("1.3");
      }
      onDispatch?.();
      return this.contents.debugger.sendCommand(command, params ?? {});
    }, signal);
  }

  private async sendDialogCleanupCommand(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    // A dialog or timed-out input can retain a protocol queue barrier. Responses
    // and prompt restoration must bypass it to release page interception.
    if (!this.contents.debugger.isAttached()) {
      this.contents.debugger.attach("1.3");
    }
    return this.contents.debugger.sendCommand(command, params ?? {});
  }
}

interface DialogDebugCommand {
  command: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  onDispatch?: () => void;
}

interface PromptShimOwner {
  collector: DialogCollector;
  signal?: AbortSignal;
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

interface GuestFrameProductionScope {
  users: number;
  previousThrottling: boolean;
}

const guestFrameProductionScopes = new WeakMap<
  BrowserAutomationWebContents,
  GuestFrameProductionScope
>();

/** Share temporary frame production across adapters for the same live guest.
 * Only the last operation restores policy, including failure and cancellation.
 * Electron 44.5+ also restores the hidden widget and Blink scheduler state.
 */
async function withGuestFrameProduction<T>(
  contents: BrowserAutomationWebContents,
  task: () => Promise<T>,
): Promise<T> {
  let scope = guestFrameProductionScopes.get(contents);
  if (!scope) {
    scope = { users: 0, previousThrottling: contents.getBackgroundThrottling() };
    if (scope.previousThrottling) contents.setBackgroundThrottling(false);
    guestFrameProductionScopes.set(contents, scope);
  }
  scope.users++;
  try {
    return await task();
  } finally {
    scope.users--;
    if (scope.users === 0) {
      guestFrameProductionScopes.delete(contents);
      if (!contents.isDestroyed() && scope.previousThrottling) {
        contents.setBackgroundThrottling(true);
      }
    }
  }
}
