import { isAbsolute, relative, resolve as resolvePath } from "node:path";

import type {
  BrowserAutomationCommand,
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationCookieEntry,
  BrowserAutomationErrorCode,
  BrowserAutomationExecuteResponse,
  BrowserAutomationExecuteRequest,
  BrowserAutomationNetworkLogEntry,
  BrowserAutomationStorageEntry,
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
  capturePage(): Promise<TabImage>;
  getConsoleMessages?(): BrowserAutomationConsoleLogEntry[];
  getCookies?(url: string): Promise<BrowserAutomationCookieEntry[]>;
  sendDebugCommand?(command: string, params?: Record<string, unknown>): Promise<unknown>;
  printToPDF?(options?: Record<string, unknown>): Promise<Uint8Array>;
  downloadURL?(input: { url: string; fileName?: string }): Promise<{
    filePath: string;
    totalBytes?: number;
    state: string;
  }>;
}

export interface TabImage {
  toPNG(): Uint8Array;
  getSize(): { width: number; height: number };
}

export interface BrowserRegistry {
  listRegisteredBrowserIds(): string[];
  listRegisteredBrowserIdsForWorkspace(workspaceId: string): string[];
  getTabContents(browserId: string): TabContents | null;
  getBrowserWorkspaceId(browserId: string): string | null;
  getWorkspaceActiveTabContents(workspaceId: string): TabContents | null;
  getWorkspaceActiveBrowserId(workspaceId: string): string | null;
  getAgentActiveBrowserId(agentId: string): string | null;
}

export type AutomationCommandPayload = BrowserAutomationExecuteResponse["payload"];
type FailurePayload = Extract<AutomationCommandPayload, { ok: false }>;

const defaultSnapshotEngine = new BrowserSnapshotEngine();
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const WAIT_POLL_INTERVAL_MS = 25;
const ALLOWED_PAGE_URL_PROTOCOLS = new Set(["http:", "https:"]);

function fail(
  requestId: string,
  code: BrowserAutomationErrorCode,
  message: string,
  retryable = false,
): FailurePayload {
  return { requestId, ok: false, error: { code, message, retryable } };
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
  rawRequest: BrowserAutomationExecuteRequest,
  registry: BrowserRegistry,
  options?: { snapshotEngine?: BrowserSnapshotEngine },
): AutomationCommandPayload | Promise<AutomationCommandPayload> {
  const request = resolveAgentBrowserTarget(rawRequest, registry);
  const { requestId, command } = request;
  const workspaceId = request.workspaceId ?? command.args.workspaceId;
  const snapshotEngine = options?.snapshotEngine ?? defaultSnapshotEngine;
  const handler = commandHandlers[command.command];

  if (!handler) {
    return fail(
      requestId,
      "browser_unsupported",
      `Unsupported command: ${(command as { command: string }).command}`,
    );
  }

  return handler({ request, command, requestId, workspaceId, registry, snapshotEngine });
}

function resolveAgentBrowserTarget(
  request: BrowserAutomationExecuteRequest,
  registry: BrowserRegistry,
): BrowserAutomationExecuteRequest {
  if (request.browserId || readCommandBrowserId(request.command)) {
    return request;
  }
  if (!request.agentId) {
    return request;
  }

  const agentBrowserId = registry.getAgentActiveBrowserId(request.agentId);
  if (!agentBrowserId) {
    return request;
  }

  return { ...request, browserId: agentBrowserId };
}

function readCommandBrowserId(command: BrowserAutomationCommand): string | undefined {
  const args = command.args as { browserId?: unknown };
  return typeof args.browserId === "string" && args.browserId.length > 0
    ? args.browserId
    : undefined;
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

const commandHandlers: Partial<Record<BrowserAutomationCommand["command"], CommandHandler>> = {
  list_tabs: ({ requestId, workspaceId, registry }) =>
    executeListTabs(requestId, workspaceId, registry),
  page_info: ({ request, command, requestId, workspaceId, registry }) => {
    const pageInfoCommand = command as Extract<BrowserAutomationCommand, { command: "page_info" }>;
    return executePageInfo(
      requestId,
      workspaceId,
      pageInfoCommand.args.browserId ?? request.browserId,
      registry,
    );
  },
  snapshot: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const snapshotCommand = command as Extract<BrowserAutomationCommand, { command: "snapshot" }>;
    return executeSnapshot(
      requestId,
      workspaceId,
      snapshotCommand.args.browserId ?? request.browserId,
      registry,
      snapshotEngine,
    );
  },
  click: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const clickCommand = command as Extract<BrowserAutomationCommand, { command: "click" }>;
    return executeClick(
      requestId,
      workspaceId,
      clickCommand.args.browserId ?? request.browserId,
      clickCommand.args.ref,
      registry,
      snapshotEngine,
    );
  },
  fill: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const fillCommand = command as Extract<BrowserAutomationCommand, { command: "fill" }>;
    return executeFill(
      requestId,
      workspaceId,
      fillCommand.args.browserId ?? request.browserId,
      fillCommand.args.ref,
      fillCommand.args.value,
      registry,
      snapshotEngine,
    );
  },
  wait: ({ request, command, requestId, workspaceId, registry }) => {
    const waitCommand = command as Extract<BrowserAutomationCommand, { command: "wait" }>;
    return executeWait(
      requestId,
      workspaceId,
      waitCommand.args.browserId ?? request.browserId,
      {
        text: waitCommand.args.text,
        url: waitCommand.args.url,
        timeoutMs: waitCommand.args.timeoutMs,
      },
      registry,
    );
  },
  type: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const typeCommand = command as Extract<BrowserAutomationCommand, { command: "type" }>;
    return executeType(
      requestId,
      workspaceId,
      typeCommand.args.browserId ?? request.browserId,
      typeCommand.args.ref,
      typeCommand.args.text,
      registry,
      snapshotEngine,
    );
  },
  keypress: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const keypressCommand = command as Extract<BrowserAutomationCommand, { command: "keypress" }>;
    return executeKeypress(
      requestId,
      workspaceId,
      keypressCommand.args.browserId ?? request.browserId,
      keypressCommand.args.ref,
      keypressCommand.args.key,
      registry,
      snapshotEngine,
    );
  },
  navigate: ({ request, command, requestId, workspaceId, registry }) => {
    const navigateCommand = command as Extract<BrowserAutomationCommand, { command: "navigate" }>;
    return executeNavigate(
      requestId,
      workspaceId,
      navigateCommand.args.browserId ?? request.browserId,
      navigateCommand.args.url,
      registry,
    );
  },
  back: ({ request, command, requestId, workspaceId, registry }) => {
    const backCommand = command as Extract<BrowserAutomationCommand, { command: "back" }>;
    return executeNavigationAction(
      requestId,
      workspaceId,
      backCommand.args.browserId ?? request.browserId,
      "back",
      registry,
    );
  },
  forward: ({ request, command, requestId, workspaceId, registry }) => {
    const forwardCommand = command as Extract<BrowserAutomationCommand, { command: "forward" }>;
    return executeNavigationAction(
      requestId,
      workspaceId,
      forwardCommand.args.browserId ?? request.browserId,
      "forward",
      registry,
    );
  },
  reload: ({ request, command, requestId, workspaceId, registry }) => {
    const reloadCommand = command as Extract<BrowserAutomationCommand, { command: "reload" }>;
    return executeNavigationAction(
      requestId,
      workspaceId,
      reloadCommand.args.browserId ?? request.browserId,
      "reload",
      registry,
    );
  },
  screenshot: ({ request, command, requestId, workspaceId, registry }) => {
    const screenshotCommand = command as Extract<
      BrowserAutomationCommand,
      { command: "screenshot" }
    >;
    return executeScreenshot(
      requestId,
      workspaceId,
      screenshotCommand.args.browserId ?? request.browserId,
      registry,
    );
  },
  full_page_screenshot: ({ request, command, requestId, workspaceId, registry }) => {
    const screenshotCommand = command as Extract<
      BrowserAutomationCommand,
      { command: "full_page_screenshot" }
    >;
    return executeFullPageScreenshot(
      requestId,
      workspaceId,
      screenshotCommand.args.browserId ?? request.browserId,
      registry,
    );
  },
  pdf: ({ request, command, requestId, workspaceId, registry }) => {
    const pdfCommand = command as Extract<BrowserAutomationCommand, { command: "pdf" }>;
    return executePdf(
      requestId,
      workspaceId,
      pdfCommand.args.browserId ?? request.browserId,
      { landscape: pdfCommand.args.landscape, printBackground: pdfCommand.args.printBackground },
      registry,
    );
  },
  download: ({ request, command, requestId, workspaceId, registry }) => {
    const downloadCommand = command as Extract<BrowserAutomationCommand, { command: "download" }>;
    return executeDownload(
      requestId,
      workspaceId,
      downloadCommand.args.browserId ?? request.browserId,
      { url: downloadCommand.args.url, fileName: downloadCommand.args.fileName },
      registry,
    );
  },
  upload: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const uploadCommand = command as Extract<BrowserAutomationCommand, { command: "upload" }>;
    return executeUpload(
      requestId,
      workspaceId,
      uploadCommand.args.browserId ?? request.browserId,
      { ref: uploadCommand.args.ref, filePaths: uploadCommand.args.filePaths },
      registry,
      snapshotEngine,
    );
  },
  focus: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const focusCommand = command as Extract<BrowserAutomationCommand, { command: "focus" }>;
    return executeFocus(
      requestId,
      workspaceId,
      focusCommand.args.browserId ?? request.browserId,
      focusCommand.args.ref,
      registry,
      snapshotEngine,
    );
  },
  clear: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const clearCommand = command as Extract<BrowserAutomationCommand, { command: "clear" }>;
    return executeClear(
      requestId,
      workspaceId,
      clearCommand.args.browserId ?? request.browserId,
      clearCommand.args.ref,
      registry,
      snapshotEngine,
    );
  },
  check: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const checkCommand = command as Extract<BrowserAutomationCommand, { command: "check" }>;
    return executeCheck(
      requestId,
      workspaceId,
      checkCommand.args.browserId ?? request.browserId,
      checkCommand.args.ref,
      checkCommand.args.checked,
      registry,
      snapshotEngine,
    );
  },
  select: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const selectCommand = command as Extract<BrowserAutomationCommand, { command: "select" }>;
    return executeSelect(
      requestId,
      workspaceId,
      selectCommand.args.browserId ?? request.browserId,
      selectCommand.args.ref,
      selectCommand.args.value,
      registry,
      snapshotEngine,
    );
  },
  hover: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const hoverCommand = command as Extract<BrowserAutomationCommand, { command: "hover" }>;
    return executeHover(
      requestId,
      workspaceId,
      hoverCommand.args.browserId ?? request.browserId,
      hoverCommand.args.ref,
      registry,
      snapshotEngine,
    );
  },
  drag: ({ request, command, requestId, workspaceId, registry, snapshotEngine }) => {
    const dragCommand = command as Extract<BrowserAutomationCommand, { command: "drag" }>;
    return executeDrag(
      requestId,
      workspaceId,
      dragCommand.args.browserId ?? request.browserId,
      dragCommand.args.sourceRef,
      dragCommand.args.targetRef,
      registry,
      snapshotEngine,
    );
  },
  logs: ({ request, command, requestId, workspaceId, registry }) => {
    const logsCommand = command as Extract<BrowserAutomationCommand, { command: "logs" }>;
    return executeLogs(
      requestId,
      workspaceId,
      logsCommand.args.browserId ?? request.browserId,
      logsCommand.args.maxEntries,
      registry,
    );
  },
  storage: ({ request, command, requestId, workspaceId, registry }) => {
    const storageCommand = command as Extract<BrowserAutomationCommand, { command: "storage" }>;
    return executeStorage(
      requestId,
      workspaceId,
      storageCommand.args.browserId ?? request.browserId,
      registry,
    );
  },
  environment: ({ request, command, requestId, workspaceId, registry }) => {
    const environmentCommand = command as Extract<
      BrowserAutomationCommand,
      { command: "environment" }
    >;
    return executeEnvironment(
      requestId,
      workspaceId,
      environmentCommand.args.browserId ?? request.browserId,
      {
        viewport: environmentCommand.args.viewport,
        geolocation: environmentCommand.args.geolocation,
      },
      registry,
    );
  },
  set_background: ({ request, command, requestId, workspaceId, registry }) => {
    const setBackgroundCommand = command as Extract<
      BrowserAutomationCommand,
      { command: "set_background" }
    >;
    return executeSetBackground(
      requestId,
      workspaceId,
      setBackgroundCommand.args.browserId ?? request.browserId,
      setBackgroundCommand.args.color,
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

function executePageInfo(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
  registry: BrowserRegistry,
): AutomationCommandPayload {
  const target = resolveTabTarget({
    requestId,
    workspaceId,
    browserId,
    registry,
  });
  if ("ok" in target) {
    return target;
  }

  return {
    requestId,
    ok: true,
    result: {
      command: "page_info",
      tab: tabInfoFromContents(
        target.browserId,
        target.contents,
        workspaceId ? registry.getWorkspaceActiveBrowserId(workspaceId) : null,
        registry.getBrowserWorkspaceId(target.browserId),
      ),
    },
  };
}

async function executeSnapshot(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
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
  browserId: string | undefined,
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
  browserId: string | undefined,
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

async function executeFocus(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
  ref: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.focus({
    browserId: target.browserId,
    page: target.contents,
    ref,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, ref);
  }
  return { requestId, ok: true, result: { command: "focus", browserId: target.browserId, ref } };
}

async function executeClear(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
  ref: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.clear({
    browserId: target.browserId,
    page: target.contents,
    ref,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, ref);
  }
  return { requestId, ok: true, result: { command: "clear", browserId: target.browserId, ref } };
}

async function executeCheck(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
  ref: string,
  checked: boolean,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const result = await snapshotEngine.check({
    browserId: target.browserId,
    page: target.contents,
    ref,
    checked,
  });
  if (!result.ok) {
    return staleRefFailure(requestId, ref);
  }
  return {
    requestId,
    ok: true,
    result: { command: "check", browserId: target.browserId, ref, checked },
  };
}

async function executeSelect(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
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
  browserId: string | undefined,
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
  browserId: string | undefined,
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
  browserId: string | undefined,
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

async function executeStorage(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  const url = target.contents.getURL();
  const cookies = (await target.contents.getCookies?.(url)) ?? [];
  const storage = parseStorageState(await target.contents.executeJavaScript(STORAGE_STATE_SCRIPT));
  return {
    requestId,
    ok: true,
    result: {
      command: "storage",
      browserId: target.browserId,
      url,
      cookies,
      localStorage: storage.localStorage,
      sessionStorage: storage.sessionStorage,
    },
  };
}

async function executeEnvironment(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
  environment: {
    viewport?: { width: number; height: number; deviceScaleFactor?: number };
    geolocation?: { latitude: number; longitude: number; accuracy?: number };
  },
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  if (environment.viewport) {
    await target.contents.sendDebugCommand?.("Emulation.setDeviceMetricsOverride", {
      width: environment.viewport.width,
      height: environment.viewport.height,
      deviceScaleFactor: environment.viewport.deviceScaleFactor ?? 1,
      mobile: false,
    });
  }
  if (environment.geolocation) {
    const geolocation = {
      latitude: environment.geolocation.latitude,
      longitude: environment.geolocation.longitude,
      accuracy: environment.geolocation.accuracy ?? 1,
    };
    await target.contents.sendDebugCommand?.("Emulation.setGeolocationOverride", geolocation);
    await target.contents.executeJavaScript(buildGeolocationShimScript(geolocation));
  }
  const viewport = parseViewport(await target.contents.executeJavaScript(VIEWPORT_SCRIPT));
  return {
    requestId,
    ok: true,
    result: {
      command: "environment",
      browserId: target.browserId,
      viewport,
      ...(environment.geolocation
        ? {
            geolocation: {
              ...environment.geolocation,
              accuracy: environment.geolocation.accuracy ?? 1,
            },
          }
        : {}),
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
  browserId: string | undefined,
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

async function executeSetBackground(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
  color: string,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }

  await target.contents.executeJavaScript(buildSetBackgroundScript(color));
  return {
    requestId,
    ok: true,
    result: { command: "set_background", browserId: target.browserId, color },
  };
}

function buildSetBackgroundScript(color: string): string {
  return String.raw`(() => {
    const color = ${JSON.stringify(color)};
    document.documentElement.style.background = color;
    if (document.body) {
      document.body.style.background = color;
      document.body.style.backgroundColor = color;
      document.body.style.minHeight = '100vh';
    }
    return true;
  })()`;
}

async function executeType(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
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
  browserId: string | undefined,
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
  browserId: string | undefined,
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
  browserId: string | undefined,
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
  browserId: string | undefined,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  if (target.contents.sendDebugCommand) {
    const screenshot = (await target.contents.sendDebugCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: false,
    })) as CdpCaptureScreenshotResult;
    if (!screenshot.data) {
      return fail(requestId, "browser_unsupported", "browser_screenshot returned no data");
    }
    const viewport = await getViewportSize(target.contents);
    return {
      requestId,
      ok: true,
      result: {
        command: "screenshot",
        browserId: target.browserId,
        mimeType: "image/png",
        dataBase64: screenshot.data,
        width: viewport.width,
        height: viewport.height,
      },
    };
  }
  const image = await target.contents.capturePage();
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

async function getViewportSize(contents: TabContents): Promise<{ width: number; height: number }> {
  const result = await contents.executeJavaScript(
    "({ width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) })",
  );
  if (!result || typeof result !== "object") {
    return { width: 0, height: 0 };
  }
  const record = result as { width?: unknown; height?: unknown };
  return {
    width: typeof record.width === "number" && Number.isFinite(record.width) ? record.width : 0,
    height: typeof record.height === "number" && Number.isFinite(record.height) ? record.height : 0,
  };
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
  browserId: string | undefined,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  if (!target.contents.sendDebugCommand) {
    return fail(requestId, "browser_unsupported", "browser_full_page_screenshot requires CDP");
  }
  const metrics = await getCdpLayoutMetrics(target.contents);
  const width = metrics.contentWidth;
  const height = metrics.contentHeight;
  const screenshot = (await target.contents.sendDebugCommand("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  })) as CdpCaptureScreenshotResult;
  if (!screenshot.data) {
    return fail(requestId, "browser_unsupported", "browser_full_page_screenshot returned no data");
  }
  return {
    requestId,
    ok: true,
    result: {
      command: "full_page_screenshot",
      browserId: target.browserId,
      mimeType: "image/png",
      dataBase64: screenshot.data,
      width,
      height,
    },
  };
}

async function executePdf(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
  options: { landscape?: boolean; printBackground: boolean },
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  if (!target.contents.printToPDF) {
    return fail(requestId, "browser_unsupported", "browser_pdf requires PDF support");
  }
  const pdf = await target.contents.printToPDF({
    printBackground: options.printBackground,
    ...(options.landscape !== undefined ? { landscape: options.landscape } : {}),
  });
  return {
    requestId,
    ok: true,
    result: {
      command: "pdf",
      browserId: target.browserId,
      mimeType: "application/pdf",
      dataBase64: Buffer.from(pdf).toString("base64"),
    },
  };
}

async function executeDownload(
  requestId: string,
  workspaceId: string | undefined,
  browserId: string | undefined,
  input: { url: string; fileName?: string },
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, workspaceId, browserId, registry });
  if ("ok" in target) {
    return target;
  }
  if (!isAllowedPageUrl(input.url)) {
    return fail(requestId, "browser_denied", "Browser download only supports http and https URLs.");
  }
  if (!target.contents.downloadURL) {
    return fail(requestId, "browser_unsupported", "browser_download requires download support");
  }
  const download = await target.contents.downloadURL(input);
  return {
    requestId,
    ok: true,
    result: {
      command: "download",
      browserId: target.browserId,
      url: input.url,
      filePath: download.filePath,
      ...(download.totalBytes !== undefined ? { totalBytes: download.totalBytes } : {}),
      state: download.state,
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
  workspaceId: string | undefined,
  browserId: string | undefined,
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
  const workspaceRoot = resolveUploadWorkspaceRoot({ workspaceId, target, registry });
  if (!workspaceRoot) {
    return fail(requestId, "browser_unsupported", "browser_upload requires a workspace target");
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

function resolveUploadWorkspaceRoot(params: {
  workspaceId: string | undefined;
  target: ResolvedTabTarget;
  registry: BrowserRegistry;
}): string | null {
  const workspaceRoot =
    params.workspaceId ?? params.registry.getBrowserWorkspaceId(params.target.browserId);
  return workspaceRoot ? resolvePath(workspaceRoot) : null;
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

function parseStorageState(value: unknown): {
  localStorage: BrowserAutomationStorageEntry[];
  sessionStorage: BrowserAutomationStorageEntry[];
} {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { localStorage: [], sessionStorage: [] };
  }
  const record = parsed as Record<string, unknown>;
  return {
    localStorage: parseStorageEntries(record.localStorage),
    sessionStorage: parseStorageEntries(record.sessionStorage),
  };
}

function parseStorageEntries(value: unknown): BrowserAutomationStorageEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): BrowserAutomationStorageEntry[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const key = readString(record.key);
    const itemValue = readString(record.value);
    return key !== null && itemValue !== null ? [{ key, value: itemValue }] : [];
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseViewport(value: unknown): {
  width: number;
  height: number;
  deviceScaleFactor: number;
} {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { width: 0, height: 0, deviceScaleFactor: 1 };
  }
  const record = parsed as Record<string, unknown>;
  return {
    width: readNumber(record.width) ?? 0,
    height: readNumber(record.height) ?? 0,
    deviceScaleFactor: readNumber(record.deviceScaleFactor) ?? 1,
  };
}

function buildGeolocationShimScript(geolocation: {
  latitude: number;
  longitude: number;
  accuracy: number;
}): string {
  return String.raw`(() => {
    const coords = ${JSON.stringify({ ...geolocation, altitude: null, altitudeAccuracy: null, heading: null, speed: null })};
    const position = { coords, timestamp: Date.now() };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) { setTimeout(() => success(position), 0); },
        watchPosition(success) { setTimeout(() => success(position), 0); return 1; },
        clearWatch() {},
      },
    });
    return true;
  })()`;
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

const STORAGE_STATE_SCRIPT = String.raw`(() => {
  function entriesFor(storage) {
    const entries = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) entries.push({ key, value: storage.getItem(key) || '' });
    }
    return entries;
  }
  function safeEntries(readStorage) {
    try {
      return entriesFor(readStorage());
    } catch {
      return [];
    }
  }
  return JSON.stringify({
    localStorage: safeEntries(() => window.localStorage),
    sessionStorage: safeEntries(() => window.sessionStorage),
  });
})()`;

const VIEWPORT_SCRIPT = String.raw`(() => JSON.stringify({
  width: window.innerWidth,
  height: window.innerHeight,
  deviceScaleFactor: window.devicePixelRatio || 1,
}))()`;

function resolveTabTarget(input: {
  requestId: string;
  workspaceId: string | undefined;
  browserId: string | undefined;
  registry: BrowserRegistry;
}): ResolvedTabTarget | FailurePayload {
  const { requestId, workspaceId, browserId, registry } = input;
  let contents: TabContents | null;
  let resolvedBrowserId: string;

  if (browserId) {
    if (workspaceId && registry.getBrowserWorkspaceId(browserId) !== workspaceId) {
      return fail(requestId, "browser_tab_not_found", `No browser tab found for ID: ${browserId}`);
    }
    contents = registry.getTabContents(browserId);
    resolvedBrowserId = browserId;
    if (!contents) {
      return fail(requestId, "browser_tab_not_found", `No browser tab found for ID: ${browserId}`);
    }
  } else {
    if (!workspaceId) {
      return fail(requestId, "browser_no_tab", "No active browser tab in workspace");
    }
    contents = registry.getWorkspaceActiveTabContents(workspaceId);
    const activeId = registry.getWorkspaceActiveBrowserId(workspaceId);
    if (!contents || !activeId) {
      return fail(requestId, "browser_no_tab", "No active browser tab in workspace");
    }
    resolvedBrowserId = activeId;
  }

  if (contents.isDestroyed()) {
    return fail(
      requestId,
      "browser_tab_closed",
      `Browser tab ${resolvedBrowserId} has been closed`,
    );
  }

  return { browserId: resolvedBrowserId, contents };
}
