import { isAbsolute, relative, resolve as resolvePath } from "node:path";

import type {
  BrowserAutomationCommand,
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationErrorCode,
  BrowserAutomationExecuteResponse,
  BrowserAutomationExecuteRequest,
  BrowserAutomationNetworkLogEntry,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BrowserSnapshotEngine } from "./snapshot-engine.js";

export interface TabContents {
  readonly id: number;
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
  capturePage(options?: TabCapturePageOptions): Promise<TabImage>;
  invalidate(): void;
  getConsoleMessages?(): BrowserAutomationConsoleLogEntry[];
  sendDebugCommand?(command: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface TabImage {
  toPNG(): Uint8Array;
  getSize(): { width: number; height: number };
}

export interface TabCapturePageOptions {
  stayHidden?: boolean;
}

export interface BrowserRegistry {
  listRegisteredBrowserIds(): string[];
  listRegisteredBrowserIdsForWorkspace(workspaceId: string): string[];
  getTabContents(browserId: string): TabContents | null;
  getBrowserWorkspaceId(browserId: string): string | null;
  getWorkspaceActiveBrowserId(workspaceId: string): string | null;
}

export type AutomationCommandPayload = BrowserAutomationExecuteResponse["payload"];
type FailurePayload = Extract<AutomationCommandPayload, { ok: false }>;

const defaultSnapshotEngine = new BrowserSnapshotEngine();
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const WAIT_POLL_INTERVAL_MS = 25;
const PIXEL_CAPTURE_TIMEOUT_MS = 5_000;
const PIXEL_CAPTURE_RETRY_INTERVAL_MS = 200;
const SCREENSHOT_NO_FRAME_MESSAGE = "The tab has not painted yet. Retry the screenshot.";
const ALLOWED_PAGE_URL_PROTOCOLS = new Set(["http:", "https:"]);
let pixelCaptureQueue: Promise<void> = Promise.resolve();

function fail(
  requestId: string,
  code: BrowserAutomationErrorCode,
  message: string,
  retryable = false,
): FailurePayload {
  return { requestId, ok: false, error: { code, message, retryable } };
}

class ScreenshotNoFrameError extends Error {
  public constructor(message = SCREENSHOT_NO_FRAME_MESSAGE) {
    super(message);
    this.name = "ScreenshotNoFrameError";
  }
}

function isScreenshotNoFrameError(error: unknown): error is ScreenshotNoFrameError {
  return error instanceof ScreenshotNoFrameError;
}

function screenshotNoFrameFailure(
  requestId: string,
  error: ScreenshotNoFrameError,
): FailurePayload {
  return fail(requestId, "screenshot_no_frame", error.message, true);
}

async function withPixelCaptureTimeout<T>(
  capture: Promise<T>,
  timeoutMs = PIXEL_CAPTURE_TIMEOUT_MS,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new ScreenshotNoFrameError();
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ScreenshotNoFrameError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([capture, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function runSerializedPixelCapture<T>(capture: () => Promise<T>): Promise<T> {
  const previous = pixelCaptureQueue;
  let releaseCurrent = () => {};
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  pixelCaptureQueue = tail;

  await previous.catch(() => {});
  try {
    return await capture();
  } finally {
    releaseCurrent();
    if (pixelCaptureQueue === tail) {
      pixelCaptureQueue = Promise.resolve();
    }
  }
}

async function capturePixelFrameWithRetry<T>(
  contents: TabContents,
  capture: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + PIXEL_CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      contents.invalidate();
      return await withPixelCaptureTimeout(capture(), deadline - Date.now());
    } catch (error) {
      if (isScreenshotNoFrameError(error)) {
        throw error;
      }
      if (!isKnownNoFrameCaptureError(error)) {
        throw error;
      }
      await delay(Math.min(PIXEL_CAPTURE_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }
  throw new ScreenshotNoFrameError();
}

function isKnownNoFrameCaptureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UnknownVizError") ||
    message.includes("No frame") ||
    message.includes("no painted frame")
  );
}

async function runPaintedPixelCapture<T>(
  contents: TabContents,
  capture: () => Promise<T>,
): Promise<T> {
  return runSerializedPixelCapture(() => capturePixelFrameWithRetry(contents, capture));
}

async function capturePaintedViewport(contents: TabContents): Promise<TabImage> {
  return runPaintedPixelCapture(contents, () => contents.capturePage({ stayHidden: false }));
}

function tabInfoFromContents(
  browserId: string,
  contents: TabContents,
  activeBrowserId: string | null,
  workspaceId: string | null,
) {
  return {
    browserId,
    ...(workspaceId ? { workspaceId } : {}),
    url: contents.getURL(),
    title: contents.getTitle(),
    isActive: activeBrowserId === browserId,
    isLoading: contents.isLoading(),
    canGoBack: contents.canGoBack(),
    canGoForward: contents.canGoForward(),
  };
}

export function executeAutomationCommand(
  request: BrowserAutomationExecuteRequest,
  registry: BrowserRegistry,
  options?: { snapshotEngine?: BrowserSnapshotEngine },
): AutomationCommandPayload | Promise<AutomationCommandPayload> {
  const { requestId, command } = request;
  const workspaceId = request.workspaceId;
  const snapshotEngine = options?.snapshotEngine ?? defaultSnapshotEngine;
  const handler = commandHandlers[command.command];

  return handler({ request, command, requestId, workspaceId, registry, snapshotEngine });
}

interface CommandHandlerContext {
  request: BrowserAutomationExecuteRequest;
  command: BrowserAutomationCommand;
  requestId: string;
  workspaceId: string | undefined;
  registry: BrowserRegistry;
  snapshotEngine: BrowserSnapshotEngine;
}

type CommandHandler = (
  context: CommandHandlerContext,
) => AutomationCommandPayload | Promise<AutomationCommandPayload>;

const commandHandlers: Record<BrowserAutomationCommand["command"], CommandHandler> = {
  list_tabs: ({ requestId, workspaceId, registry }) =>
    executeListTabs(requestId, workspaceId, registry),
  new_tab: ({ requestId }) =>
    fail(requestId, "browser_unsupported", "browser_new_tab is handled by the app runtime."),
  snapshot: ({ command, requestId, workspaceId, registry, snapshotEngine }) => {
    const snapshotCommand = command as Extract<BrowserAutomationCommand, { command: "snapshot" }>;
    return executeSnapshot(
      requestId,
      workspaceId,
      snapshotCommand.args.browserId,
      registry,
      snapshotEngine,
    );
  },
  click: ({ command, requestId, workspaceId, registry, snapshotEngine }) => {
    const clickCommand = command as Extract<BrowserAutomationCommand, { command: "click" }>;
    return executeClick(
      requestId,
      workspaceId,
      clickCommand.args.browserId,
      clickCommand.args.ref,
      registry,
      snapshotEngine,
    );
  },
  fill: ({ command, requestId, workspaceId, registry, snapshotEngine }) => {
    const fillCommand = command as Extract<BrowserAutomationCommand, { command: "fill" }>;
    return executeFill(
      requestId,
      workspaceId,
      fillCommand.args.browserId,
      fillCommand.args.ref,
      fillCommand.args.value,
      registry,
      snapshotEngine,
    );
  },
  wait: ({ command, requestId, workspaceId, registry }) => {
    const waitCommand = command as Extract<BrowserAutomationCommand, { command: "wait" }>;
    return executeWait(
      requestId,
      workspaceId,
      waitCommand.args.browserId,
      {
        text: waitCommand.args.text,
        url: waitCommand.args.url,
        timeoutMs: waitCommand.args.timeoutMs,
      },
      registry,
    );
  },
  type: ({ command, requestId, workspaceId, registry, snapshotEngine }) => {
    const typeCommand = command as Extract<BrowserAutomationCommand, { command: "type" }>;
    return executeType(
      requestId,
      workspaceId,
      typeCommand.args.browserId,
      typeCommand.args.ref,
      typeCommand.args.text,
      registry,
      snapshotEngine,
    );
  },
  keypress: ({ command, requestId, workspaceId, registry, snapshotEngine }) => {
    const keypressCommand = command as Extract<BrowserAutomationCommand, { command: "keypress" }>;
    return executeKeypress(
      requestId,
      workspaceId,
      keypressCommand.args.browserId,
      keypressCommand.args.ref,
      keypressCommand.args.key,
      registry,
      snapshotEngine,
    );
  },
  navigate: ({ command, requestId, workspaceId, registry }) => {
    const navigateCommand = command as Extract<BrowserAutomationCommand, { command: "navigate" }>;
    return executeNavigate(
      requestId,
      workspaceId,
      navigateCommand.args.browserId,
      navigateCommand.args.url,
      registry,
    );
  },
  back: ({ command, requestId, workspaceId, registry }) => {
    const backCommand = command as Extract<BrowserAutomationCommand, { command: "back" }>;
    return executeNavigationAction(
      requestId,
      workspaceId,
      backCommand.args.browserId,
      "back",
      registry,
    );
  },
  forward: ({ command, requestId, workspaceId, registry }) => {
    const forwardCommand = command as Extract<BrowserAutomationCommand, { command: "forward" }>;
    return executeNavigationAction(
      requestId,
      workspaceId,
      forwardCommand.args.browserId,
      "forward",
      registry,
    );
  },
  reload: ({ command, requestId, workspaceId, registry }) => {
    const reloadCommand = command as Extract<BrowserAutomationCommand, { command: "reload" }>;
    return executeNavigationAction(
      requestId,
      workspaceId,
      reloadCommand.args.browserId,
      "reload",
      registry,
    );
  },
  screenshot: ({ command, requestId, workspaceId, registry }) => {
    const screenshotCommand = command as Extract<
      BrowserAutomationCommand,
      { command: "screenshot" }
    >;
    return executeScreenshot(
      requestId,
      workspaceId,
      screenshotCommand.args.browserId,
      screenshotCommand.args.fullPage,
      registry,
    );
  },
  upload: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const uploadCommand = command as Extract<BrowserAutomationCommand, { command: "upload" }>;
    return executeUpload(
      requestId,
      request.cwd,
      workspaceId,
      uploadCommand.args.browserId,
      { ref: uploadCommand.args.ref, filePaths: uploadCommand.args.filePaths },
      registry,
      snapshotEngine,
    );
  },
  select: ({ command, requestId, workspaceId, registry, snapshotEngine }) => {
    const selectCommand = command as Extract<BrowserAutomationCommand, { command: "select" }>;
    return executeSelect(
      requestId,
      workspaceId,
      selectCommand.args.browserId,
      selectCommand.args.ref,
      selectCommand.args.value,
      registry,
      snapshotEngine,
    );
  },
  hover: ({ command, requestId, workspaceId, registry, snapshotEngine }) => {
    const hoverCommand = command as Extract<BrowserAutomationCommand, { command: "hover" }>;
    return executeHover(
      requestId,
      workspaceId,
      hoverCommand.args.browserId,
      hoverCommand.args.ref,
      registry,
      snapshotEngine,
    );
  },
  drag: ({ command, requestId, workspaceId, registry, snapshotEngine }) => {
    const dragCommand = command as Extract<BrowserAutomationCommand, { command: "drag" }>;
    return executeDrag(
      requestId,
      workspaceId,
      dragCommand.args.browserId,
      dragCommand.args.sourceRef,
      dragCommand.args.targetRef,
      registry,
      snapshotEngine,
    );
  },
  logs: ({ command, requestId, workspaceId, registry }) => {
    const logsCommand = command as Extract<BrowserAutomationCommand, { command: "logs" }>;
    return executeLogs(
      requestId,
      workspaceId,
      logsCommand.args.browserId,
      logsCommand.args.maxEntries,
      registry,
    );
  },
};

interface ResolvedTabTarget {
  browserId: string;
  contents: TabContents;
}

function executeListTabs(
  requestId: string,
  workspaceId: string | undefined,
  registry: BrowserRegistry,
): AutomationCommandPayload {
  const browserIds = workspaceId
    ? registry.listRegisteredBrowserIdsForWorkspace(workspaceId)
    : registry.listRegisteredBrowserIds();
  const activeBrowserId = workspaceId ? registry.getWorkspaceActiveBrowserId(workspaceId) : null;
  const tabs: Array<ReturnType<typeof tabInfoFromContents>> = [];

  for (const browserId of browserIds) {
    const contents = registry.getTabContents(browserId);
    if (contents && !contents.isDestroyed()) {
      tabs.push(
        tabInfoFromContents(
          browserId,
          contents,
          activeBrowserId,
          registry.getBrowserWorkspaceId(browserId),
        ),
      );
    }
  }

  return { requestId, ok: true, result: { command: "list_tabs", tabs } };
}

async function executeSnapshot(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({
    requestId,
    workspaceId,
    browserId,
    registry,
  });
  if ("ok" in target) {
    return target;
  }

  const elements = await snapshotEngine.snapshot({
    browserId: target.browserId,
    page: target.contents,
  });

  return {
    requestId,
    ok: true,
    result: {
      command: "snapshot",
      browserId: target.browserId,
      ...(registry.getBrowserWorkspaceId(target.browserId)
        ? { workspaceId: registry.getBrowserWorkspaceId(target.browserId) ?? undefined }
        : {}),
      url: target.contents.getURL(),
      title: target.contents.getTitle(),
      elements,
    },
  };
}

async function executeClick(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  ref: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.click({
    browserId: target.browserId,
    page: target.contents,
    ref,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, ref);
  }
  return { requestId, ok: true, result: { command: "click", browserId: target.browserId, ref } };
}

async function executeFill(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  ref: string,
  value: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.fill({
    browserId: target.browserId,
    page: target.contents,
    ref,
    value,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, ref);
  }
  return { requestId, ok: true, result: { command: "fill", browserId: target.browserId, ref } };
}

async function executeSelect(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  ref: string,
  value: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.select({
    browserId: target.browserId,
    page: target.contents,
    ref,
    value,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, ref);
  }
  return {
    requestId,
    ok: true,
    result: { command: "select", browserId: target.browserId, ref, value },
  };
}

async function executeHover(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  ref: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.hover({
    browserId: target.browserId,
    page: target.contents,
    ref,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, ref);
  }
  return { requestId, ok: true, result: { command: "hover", browserId: target.browserId, ref } };
}

async function executeDrag(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  sourceRef: string,
  targetRef: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.drag({
    browserId: target.browserId,
    page: target.contents,
    sourceRef,
    targetRef,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, `${sourceRef}/${targetRef}`);
  }
  return {
    requestId,
    ok: true,
    result: { command: "drag", browserId: target.browserId, sourceRef, targetRef },
  };
}

async function executeLogs(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  maxEntries: number,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const consoleMessages = target.contents.getConsoleMessages?.() ?? [];
  const networkEntries = parseNetworkEntries(
    await target.contents.executeJavaScript(NETWORK_PERFORMANCE_SCRIPT),
  );
  return {
    requestId,
    ok: true,
    result: {
      command: "logs",
      browserId: target.browserId,
      console: consoleMessages.slice(-maxEntries),
      network: networkEntries.slice(-maxEntries),
    },
  };
}

function staleRefFailure(requestId: string, ref: string): FailurePayload {
  return fail(
    requestId,
    "browser_stale_ref",
    `Browser element reference ${ref} is stale. Take a new snapshot and try again.`,
  );
}

async function executeWait(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  condition: { text?: string; url?: string; timeoutMs?: number },
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }

  if (!condition.text && !condition.url) {
    return fail(requestId, "browser_unsupported", "browser_wait requires text or url");
  }

  const timeoutMs = condition.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  do {
    if (condition.url && target.contents.getURL().includes(condition.url)) {
      return {
        requestId,
        ok: true,
        result: { command: "wait", browserId: target.browserId, matched: "url" },
      };
    }
    if (condition.text) {
      const pageText = await target.contents.executeJavaScript("document.body.innerText || ''");
      if (typeof pageText === "string" && pageText.includes(condition.text)) {
        return {
          requestId,
          ok: true,
          result: { command: "wait", browserId: target.browserId, matched: "text" },
        };
      }
    }
    await delay(WAIT_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);

  if (condition.text) {
    return fail(
      requestId,
      "browser_timeout",
      `Timed out waiting for browser text: ${condition.text}`,
      true,
    );
  }
  if (condition.url) {
    return fail(
      requestId,
      "browser_timeout",
      `Timed out waiting for browser URL: ${condition.url}`,
      true,
    );
  }
  return fail(requestId, "browser_unsupported", "browser_wait requires text or url");
}

async function executeType(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  ref: string | undefined,
  text: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.typeText({
    browserId: target.browserId,
    page: target.contents,
    ...(ref ? { ref } : {}),
    text,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, ref ?? "@e0");
  }
  return {
    requestId,
    ok: true,
    result: { command: "type", browserId: target.browserId, ...(ref ? { ref } : {}) },
  };
}

async function executeKeypress(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  ref: string | undefined,
  key: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.keypress({
    browserId: target.browserId,
    page: target.contents,
    ...(ref ? { ref } : {}),
    key,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, ref ?? "@e0");
  }
  return {
    requestId,
    ok: true,
    result: { command: "keypress", browserId: target.browserId, key, ...(ref ? { ref } : {}) },
  };
}

async function executeNavigate(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  url: string,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  if (!isAllowedPageUrl(url)) {
    return fail(
      requestId,
      "browser_denied",
      "Browser navigation only supports http and https URLs.",
    );
  }
  await target.contents.loadURL(url);
  return { requestId, ok: true, result: { command: "navigate", browserId: target.browserId, url } };
}

function executeNavigationAction(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  action: "back" | "forward" | "reload",
  registry: BrowserRegistry,
): AutomationCommandPayload {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  if (action === "back") {
    target.contents.goBack();
    return { requestId, ok: true, result: { command: "back", browserId: target.browserId } };
  }
  if (action === "forward") {
    target.contents.goForward();
    return { requestId, ok: true, result: { command: "forward", browserId: target.browserId } };
  }
  target.contents.reload();
  return { requestId, ok: true, result: { command: "reload", browserId: target.browserId } };
}

async function executeScreenshot(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  fullPage: boolean,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  if (fullPage) {
    return executeFullPageScreenshot(requestId, workspaceId, browserId, registry);
  }

  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  let image: TabImage;
  try {
    image = await capturePaintedViewport(target.contents);
  } catch (error) {
    if (isScreenshotNoFrameError(error)) {
      return screenshotNoFrameFailure(requestId, error);
    }
    throw error;
  }
  const size = image.getSize();
  return {
    requestId,
    ok: true,
    result: {
      command: "screenshot",
      browserId: target.browserId,
      mimeType: "image/png",
      dataBase64: Buffer.from(image.toPNG()).toString("base64"),
      width: size.width,
      height: size.height,
    },
  };
}

interface CdpLayoutMetrics {
  cssLayoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
  };
  layoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
  };
  cssContentSize?: {
    width?: number;
    height?: number;
  };
  contentSize?: {
    width?: number;
    height?: number;
  };
}

interface CdpCaptureScreenshotResult {
  data?: string;
}

async function getCdpLayoutMetrics(contents: TabContents): Promise<{
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
}> {
  if (!contents.sendDebugCommand) {
    return { viewportWidth: 0, viewportHeight: 0, contentWidth: 0, contentHeight: 0 };
  }
  const metrics = (await contents.sendDebugCommand("Page.getLayoutMetrics")) as CdpLayoutMetrics;
  const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
  const contentSize = metrics.cssContentSize ?? metrics.contentSize;
  return {
    viewportWidth: Math.ceil(viewport?.clientWidth ?? 0),
    viewportHeight: Math.ceil(viewport?.clientHeight ?? 0),
    contentWidth: Math.ceil(contentSize?.width ?? 0),
    contentHeight: Math.ceil(contentSize?.height ?? 0),
  };
}

async function executeFullPageScreenshot(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  if (!target.contents.sendDebugCommand) {
    return fail(requestId, "browser_unsupported", "browser_screenshot fullPage requires CDP");
  }
  const sendDebugCommand = target.contents.sendDebugCommand.bind(target.contents);
  let screenshot: CdpCaptureScreenshotResult;
  let width = 0;
  let height = 0;
  try {
    screenshot = await runPaintedPixelCapture(target.contents, async () => {
      const metrics = await getCdpLayoutMetrics(target.contents);
      width = metrics.contentWidth;
      height = metrics.contentHeight;
      return (await sendDebugCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      })) as CdpCaptureScreenshotResult;
    });
  } catch (error) {
    if (isScreenshotNoFrameError(error)) {
      return screenshotNoFrameFailure(requestId, error);
    }
    throw error;
  }
  if (!screenshot.data) {
    return fail(requestId, "browser_unsupported", "browser_screenshot fullPage returned no data");
  }
  return {
    requestId,
    ok: true,
    result: {
      command: "screenshot",
      browserId: target.browserId,
      mimeType: "image/png",
      dataBase64: screenshot.data,
      width,
      height,
    },
  };
}

function isAllowedPageUrl(value: string): boolean {
  try {
    return ALLOWED_PAGE_URL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function executeUpload(
  requestId: string,
  cwd: string | undefined,
  workspaceId: string | undefined,
  browserId: string,
  input: { ref: string; filePaths: string[] },
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  if (!target.contents.sendDebugCommand) {
    return fail(requestId, "browser_unsupported", "browser_upload requires CDP");
  }
  const resolved = snapshotEngine.selectorForRef({
    browserId: target.browserId,
    page: target.contents,
    ref: input.ref,
  });
  if (!resolved.ok) {
    return staleRefFailure(requestId, input.ref);
  }
  const document = (await target.contents.sendDebugCommand("DOM.getDocument", {
    depth: -1,
    pierce: true,
  })) as { root?: { nodeId?: number } };
  const rootNodeId = document.root?.nodeId;
  if (typeof rootNodeId !== "number") {
    return fail(requestId, "browser_unsupported", "browser_upload could not read DOM");
  }
  const queried = (await target.contents.sendDebugCommand("DOM.querySelector", {
    nodeId: rootNodeId,
    selector: resolved.selector,
  })) as { nodeId?: number };
  if (typeof queried.nodeId !== "number" || queried.nodeId <= 0) {
    return staleRefFailure(requestId, input.ref);
  }
  const workspaceRoot = resolveUploadWorkspaceRoot(cwd);
  if (!workspaceRoot) {
    return fail(requestId, "browser_unsupported", "browser_upload requires request cwd");
  }
  const filePaths = resolveWorkspaceFilePaths(input.filePaths, workspaceRoot);
  if (!filePaths) {
    return fail(
      requestId,
      "browser_unsupported",
      "browser_upload only accepts files inside the agent workspace.",
    );
  }

  await target.contents.sendDebugCommand("DOM.setFileInputFiles", {
    nodeId: queried.nodeId,
    files: filePaths,
  });
  return {
    requestId,
    ok: true,
    result: {
      command: "upload",
      browserId: target.browserId,
      ref: input.ref,
      filePaths,
    },
  };
}

function resolveUploadWorkspaceRoot(cwd: string | undefined): string | null {
  return cwd ? resolvePath(cwd) : null;
}

function resolveWorkspaceFilePaths(filePaths: string[], workspaceRoot: string): string[] | null {
  const resolvedPaths = filePaths.map((filePath) =>
    isAbsolute(filePath) ? resolvePath(filePath) : resolvePath(workspaceRoot, filePath),
  );
  if (resolvedPaths.some((filePath) => !isPathInsideDirectory(filePath, workspaceRoot))) {
    return null;
  }
  return resolvedPaths;
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const relativePath = relative(directory, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNetworkEntries(value: unknown): BrowserAutomationNetworkLogEntry[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry): BrowserAutomationNetworkLogEntry[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const url = readString(record.url);
    const startTime = readNumber(record.startTime);
    const duration = readNumber(record.duration);
    if (!url || startTime === null || duration === null) {
      return [];
    }
    return [
      {
        url,
        ...(readString(record.method) ? { method: readString(record.method) ?? undefined } : {}),
        ...(readNumber(record.status) !== null
          ? { status: readNumber(record.status) ?? undefined }
          : {}),
        ...(readString(record.type) ? { type: readString(record.type) ?? undefined } : {}),
        startTime,
        duration,
        ...(readNumber(record.transferSize) !== null
          ? { transferSize: readNumber(record.transferSize) ?? undefined }
          : {}),
      },
    ];
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const NETWORK_PERFORMANCE_SCRIPT = String.raw`(() => {
  const entries = performance.getEntriesByType('resource')
    .concat(performance.getEntriesByType('navigation'))
    .slice(-200)
    .map((entry) => ({
      url: entry.name,
      method: entry.initiatorType === 'navigation' ? 'GET' : undefined,
      type: entry.initiatorType,
      startTime: entry.startTime,
      duration: entry.duration,
      transferSize: typeof entry.transferSize === 'number' ? entry.transferSize : undefined,
    }));
  return JSON.stringify(entries);
})()`;

function resolveTabTarget(input: {
  requestId: string;
  workspaceId: string | undefined;
  browserId: string;
  registry: BrowserRegistry;
}): ResolvedTabTarget | FailurePayload {
  const { requestId, workspaceId, browserId, registry } = input;
  if (workspaceId && registry.getBrowserWorkspaceId(browserId) !== workspaceId) {
    return fail(requestId, "browser_tab_not_found", `No browser tab found for ID: ${browserId}`);
  }

  const contents = registry.getTabContents(browserId);
  if (!contents) {
    return fail(requestId, "browser_tab_not_found", `No browser tab found for ID: ${browserId}`);
  }

  if (contents.isDestroyed()) {
    return fail(requestId, "browser_tab_closed", `Browser tab ${browserId} has been closed`);
  }

  return { browserId, contents };
}
