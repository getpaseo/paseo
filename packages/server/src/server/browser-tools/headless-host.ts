import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  BrowserAutomationCommand,
  BrowserAutomationCommandName,
  BrowserAutomationExecuteRequest,
  BrowserAutomationTabInfo,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserScreencastFrame } from "@getpaseo/protocol/binary-frames/screencast";
import { BrowserScreencastOpcode } from "@getpaseo/protocol/binary-frames/screencast";
import { HEADLESS_BROWSER_HOST_KIND, type BrowserToolsBroker } from "./broker.js";
import {
  BrowserToolsRequestError,
  browserToolsFailure,
  createBrowserToolsRequestError,
  type BrowserToolsResponsePayload,
} from "./errors.js";
import {
  connectCdpWebSocket,
  CdpCommandError,
  CdpConnectError,
  CdpConnectionClosedError,
  isLoopbackCdpEndpoint,
  type CdpConnection,
  type CdpConnector,
  type CdpEvent,
  type CdpResult,
} from "./cdp-connection.js";
import {
  dispatchTrustedClick,
  dispatchTrustedKeyEvent,
  dispatchTrustedMousePhase,
  dispatchTrustedScroll,
  type CdpCommandSender,
} from "./cdp-input.js";

/**
 * Exactly what a remote CDP endpoint can serve. The ref-based commands
 * (`snapshot`, `click`, `fill`, ...) need the guest-side snapshot engine the
 * Electron host injects, so they stay off this list and the broker refuses them
 * here instead of the host answering with something it cannot do.
 */
export const HEADLESS_BROWSER_HOST_COMMANDS = [
  "list_tabs",
  "new_tab",
  "navigate",
  "back",
  "forward",
  "reload",
  "close_tab",
  "resize",
  "screenshot",
  "input_at",
  "screencast_start",
  "screencast_stop",
] as const satisfies readonly BrowserAutomationCommandName[];

const RECONNECT_DELAY_MS = 5_000;
// Chrome only emits a screencast frame when the page is damaged, so a viewer
// that subscribes to a settled page sees nothing until something moves.
const FIRST_FRAME_DELAY_MS = 250;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type HeadlessBrowserHostBroker = Pick<BrowserToolsBroker, "registerClient" | "receiveResponse">;

/** Where a headless host's side effects land in the running daemon. */
export interface HeadlessBrowserHostSink {
  handleScreencastFrame(params: { frame: BrowserScreencastFrame; sourceClientId: string }): void;
  /** The host's tab set changed, so every client should re-read it. */
  announceTabsChanged(): void;
}

export interface HeadlessBrowserHostLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface HeadlessBrowserHostOptions {
  endpoint: string;
  broker: HeadlessBrowserHostBroker;
  sink: HeadlessBrowserHostSink;
  logger: HeadlessBrowserHostLogger;
  connect?: CdpConnector;
  clientId?: string;
  reconnectDelayMs?: number;
  firstFrameDelayMs?: number;
}

export interface HeadlessBrowserHost {
  stop(): void;
}

interface HeadlessScreencast {
  slot: number;
  quality: number;
  hasEmitted: boolean;
  firstFrameTimer: ReturnType<typeof setTimeout> | null;
}

interface HeadlessTab {
  browserId: string;
  targetId: string;
  sessionId: string;
  /** Set only for tabs this host opened, which is the only workspace it knows. */
  workspaceId: string | undefined;
  screencast: HeadlessScreencast | null;
}

interface CdpTargetInfo {
  targetId: string;
  url: string;
  title: string;
}

/**
 * Attaches the daemon to a CDP endpoint the operator already runs and registers
 * it as a browser host, so a headless server mirrors and automates a browser of
 * its own with no desktop app connected. Reconnects until stopped, because the
 * browser is a separate process that may come up after the daemon or restart
 * under it.
 */
export function startHeadlessBrowserHost(options: HeadlessBrowserHostOptions): HeadlessBrowserHost {
  const connect = options.connect ?? connectCdpWebSocket;
  const reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  let stopped = false;
  let session: HeadlessBrowserSession | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void attach();
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  }

  async function attach(): Promise<void> {
    if (stopped) {
      return;
    }
    let connection: CdpConnection;
    try {
      connection = await connect(options.endpoint);
    } catch (error) {
      options.logger.warn(
        { err: error, endpoint: options.endpoint },
        "browser_headless_host_connect_failed",
      );
      scheduleReconnect();
      return;
    }
    if (stopped) {
      connection.close();
      return;
    }
    session = new HeadlessBrowserSession({
      connection,
      broker: options.broker,
      sink: options.sink,
      clientId: options.clientId ?? `headless_browser_${randomUUID()}`,
      firstFrameDelayMs: options.firstFrameDelayMs ?? FIRST_FRAME_DELAY_MS,
      isDaemonLocal: isLoopbackCdpEndpoint(options.endpoint),
    });
    connection.onClose(() => {
      session?.dispose();
      session = null;
      options.logger.warn({ endpoint: options.endpoint }, "browser_headless_host_disconnected");
      // The tabs this host served left with it, so viewers must stop listing them.
      options.sink.announceTabsChanged();
      scheduleReconnect();
    });
    options.logger.info({ endpoint: options.endpoint }, "browser_headless_host_connected");
    options.sink.announceTabsChanged();
  }

  void attach();

  return {
    stop(): void {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      session?.dispose();
      session = null;
    },
  };
}

export interface ConfiguredHeadlessBrowserHostOptions extends Omit<
  HeadlessBrowserHostOptions,
  "endpoint"
> {
  endpoint: string | undefined;
}

/** No configured endpoint means no daemon-owned browser, and nothing changes. */
export function startConfiguredHeadlessBrowserHost(
  options: ConfiguredHeadlessBrowserHostOptions,
): HeadlessBrowserHost | null {
  const { endpoint, ...rest } = options;
  if (!endpoint) {
    return null;
  }
  return startHeadlessBrowserHost({ ...rest, endpoint });
}

interface HeadlessBrowserSessionOptions {
  connection: CdpConnection;
  broker: HeadlessBrowserHostBroker;
  sink: HeadlessBrowserHostSink;
  clientId: string;
  firstFrameDelayMs: number;
  isDaemonLocal: boolean;
}

/** One live CDP connection registered with the broker as a browser host. */
class HeadlessBrowserSession {
  private readonly connection: CdpConnection;
  private readonly broker: HeadlessBrowserHostBroker;
  private readonly sink: HeadlessBrowserHostSink;
  private readonly clientId: string;
  private readonly firstFrameDelayMs: number;
  private readonly tabsByBrowserId = new Map<string, HeadlessTab>();
  private readonly unregister: () => void;
  private disposed = false;

  public constructor(options: HeadlessBrowserSessionOptions) {
    this.connection = options.connection;
    this.broker = options.broker;
    this.sink = options.sink;
    this.clientId = options.clientId;
    this.firstFrameDelayMs = options.firstFrameDelayMs;

    this.connection.onEvent((event) => {
      this.handleCdpEvent(event);
    });
    this.unregister = this.broker.registerClient({
      id: this.clientId,
      hostKind: HEADLESS_BROWSER_HOST_KIND,
      label: hostname(),
      // Only true for a browser on this machine. A remote endpoint - Browserless,
      // or Chrome on another box - cannot reach the daemon's localhost services,
      // so it must not win the new-tab routing that promise is for.
      isDaemonLocal: options.isDaemonLocal,
      supportedCommands: HEADLESS_BROWSER_HOST_COMMANDS,
      sendBrowserAutomationRequest: (request) => this.handleRequest(request),
    });
    // Chrome withholds Target.targetInfoChanged until discovery is on, and that
    // event is the only notice a viewer gets that the guest navigated itself.
    void this.send({ method: "Target.setDiscoverTargets", params: { discover: true } }).catch(
      () => {},
    );
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const tab of this.tabsByBrowserId.values()) {
      clearFirstFrameTimer(tab.screencast);
    }
    this.tabsByBrowserId.clear();
    this.unregister();
    this.connection.close();
  }

  private async handleRequest(request: BrowserAutomationExecuteRequest): Promise<void> {
    const payload = await this.execute(request).catch((error: unknown) =>
      toFailurePayload(request.requestId, error),
    );
    this.broker.receiveResponse({
      type: "browser.automation.execute.response",
      payload,
    });
  }

  private async execute(
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserToolsResponsePayload> {
    const { requestId } = request;
    const command = request.command;
    switch (command.command) {
      case "list_tabs":
        return {
          requestId,
          ok: true,
          result: { command: "list_tabs", tabs: await this.listTabs() },
        };
      case "new_tab":
        return this.newTab(requestId, request.workspaceId, command.args.url);
      case "navigate":
        return this.navigate(requestId, command.args.browserId, command.args.url);
      case "back":
        return this.goToHistoryOffset(requestId, command.args.browserId, "back");
      case "forward":
        return this.goToHistoryOffset(requestId, command.args.browserId, "forward");
      case "reload":
        return this.reload(requestId, command.args.browserId);
      case "close_tab":
        return this.closeTab(requestId, command.args.browserId);
      case "resize":
        return this.resize(requestId, command.args);
      case "screenshot":
        return this.screenshot(requestId, command.args.browserId, command.args.fullPage);
      case "input_at":
        return this.inputAt(requestId, command.args.browserId, command.args.event);
      case "screencast_start":
        return this.screencastStart(requestId, command.args);
      case "screencast_stop":
        return this.screencastStop(requestId, command.args.browserId);
      default:
        return browserToolsFailure({
          requestId,
          code: "browser_unsupported",
          message: `Browser automation command "${command.command}" is not supported by the ${HEADLESS_BROWSER_HOST_KIND}.`,
        });
    }
  }

  private async listTabs(): Promise<BrowserAutomationTabInfo[]> {
    const targets = await this.syncTargets();
    return Promise.all(
      targets.map(async (target) => {
        const history = await this.readNavigationHistory(target.tab);
        return toTabInfo(target, history);
      }),
    );
  }

  /**
   * `Target.getTargets` is the truth about which pages exist, so every listing
   * adopts new targets, keeps ids stable for ones already seen, and forgets the
   * ones that are gone.
   */
  private async syncTargets(): Promise<SyncedHeadlessTab[]> {
    const result = await this.send({ method: "Target.getTargets" });
    const infos = readPageTargets(result);
    const tabsByTargetId = new Map(
      Array.from(this.tabsByBrowserId.values()).map((tab) => [tab.targetId, tab]),
    );

    const synced: SyncedHeadlessTab[] = [];
    for (const info of infos) {
      const existing = tabsByTargetId.get(info.targetId);
      synced.push({ tab: existing ?? (await this.adoptTarget(info.targetId, undefined)), info });
    }

    const liveTargetIds = new Set(infos.map((info) => info.targetId));
    for (const tab of Array.from(this.tabsByBrowserId.values())) {
      if (liveTargetIds.has(tab.targetId)) {
        continue;
      }
      clearFirstFrameTimer(tab.screencast);
      this.tabsByBrowserId.delete(tab.browserId);
    }
    return synced;
  }

  private async adoptTarget(
    targetId: string,
    workspaceId: string | undefined,
  ): Promise<HeadlessTab> {
    const attached = await this.send({
      method: "Target.attachToTarget",
      // Flat sessions multiplex every target over the one browser socket, so
      // each command and event carries the session it belongs to.
      params: { targetId, flatten: true },
    });
    const sessionId = readString(attached.sessionId);
    if (sessionId === null) {
      throw createBrowserToolsRequestError({
        code: "browser_unknown_error",
        message: `Target.attachToTarget returned no sessionId for target ${targetId}.`,
      });
    }
    const tab: HeadlessTab = {
      browserId: randomUUID(),
      targetId,
      sessionId,
      workspaceId,
      screencast: null,
    };
    this.tabsByBrowserId.set(tab.browserId, tab);
    return tab;
  }

  private async newTab(
    requestId: string,
    workspaceId: string | undefined,
    url: string | undefined,
  ): Promise<BrowserToolsResponsePayload> {
    if (!workspaceId) {
      return browserToolsFailure({
        requestId,
        code: "browser_unsupported",
        message: "Cannot create a browser tab without a workspace context.",
      });
    }
    const targetUrl = url ?? "about:blank";
    const created = await this.send({
      method: "Target.createTarget",
      params: { url: targetUrl },
    });
    const targetId = readString(created.targetId);
    if (targetId === null) {
      throw createBrowserToolsRequestError({
        code: "browser_unknown_error",
        message: "Target.createTarget returned no targetId.",
      });
    }
    const tab = await this.adoptTarget(targetId, workspaceId);
    this.sink.announceTabsChanged();
    return {
      requestId,
      ok: true,
      result: { command: "new_tab", browserId: tab.browserId, workspaceId, url: targetUrl },
    };
  }

  private async navigate(
    requestId: string,
    browserId: string,
    url: string,
  ): Promise<BrowserToolsResponsePayload> {
    const tab = this.requireTab(browserId);
    await this.send({ method: "Page.navigate", params: { url }, sessionId: tab.sessionId });
    return { requestId, ok: true, result: { command: "navigate", browserId, url } };
  }

  private async goToHistoryOffset(
    requestId: string,
    browserId: string,
    direction: "back" | "forward",
  ): Promise<BrowserToolsResponsePayload> {
    const tab = this.requireTab(browserId);
    const history = await this.readNavigationHistory(tab);
    const index = direction === "back" ? history.currentIndex - 1 : history.currentIndex + 1;
    const entry = history.entries[index];
    if (!entry) {
      throw createBrowserToolsRequestError({
        code: "browser_denied",
        message: `Browser tab ${browserId} has no ${direction} history entry.`,
      });
    }
    await this.send({
      method: "Page.navigateToHistoryEntry",
      params: { entryId: entry.id },
      sessionId: tab.sessionId,
    });
    return { requestId, ok: true, result: { command: direction, browserId } };
  }

  private async reload(requestId: string, browserId: string): Promise<BrowserToolsResponsePayload> {
    const tab = this.requireTab(browserId);
    await this.send({ method: "Page.reload", sessionId: tab.sessionId });
    return { requestId, ok: true, result: { command: "reload", browserId } };
  }

  private async closeTab(
    requestId: string,
    browserId: string,
  ): Promise<BrowserToolsResponsePayload> {
    const tab = this.requireTab(browserId);
    clearFirstFrameTimer(tab.screencast);
    this.tabsByBrowserId.delete(browserId);
    await this.send({ method: "Target.closeTarget", params: { targetId: tab.targetId } });
    this.sink.announceTabsChanged();
    return { requestId, ok: true, result: { command: "close_tab", browserId } };
  }

  private async resize(
    requestId: string,
    args: { browserId: string; width: number; height: number },
  ): Promise<BrowserToolsResponsePayload> {
    const tab = this.requireTab(args.browserId);
    await this.send({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: args.width, height: args.height, deviceScaleFactor: 1, mobile: false },
      sessionId: tab.sessionId,
    });
    return {
      requestId,
      ok: true,
      result: {
        command: "resize",
        browserId: args.browserId,
        width: args.width,
        height: args.height,
      },
    };
  }

  private async screenshot(
    requestId: string,
    browserId: string,
    fullPage: boolean,
  ): Promise<BrowserToolsResponsePayload> {
    const tab = this.requireTab(browserId);
    const shot = await this.send({
      method: "Page.captureScreenshot",
      params: { format: "png", captureBeyondViewport: fullPage },
      sessionId: tab.sessionId,
    });
    const dataBase64 = readString(shot.data);
    if (dataBase64 === null) {
      throw createBrowserToolsRequestError({
        code: "screenshot_no_frame",
        message: `Browser tab ${browserId} returned no screenshot data.`,
      });
    }
    const size = readPngSize(Buffer.from(dataBase64, "base64"));
    return {
      requestId,
      ok: true,
      result: {
        command: "screenshot",
        browserId,
        mimeType: "image/png",
        dataBase64,
        width: size.width,
        height: size.height,
      },
    };
  }

  private async inputAt(
    requestId: string,
    browserId: string,
    event: Extract<BrowserAutomationCommand, { command: "input_at" }>["args"]["event"],
  ): Promise<BrowserToolsResponsePayload> {
    const tab = this.requireTab(browserId);
    const send: CdpCommandSender = (method, params) =>
      this.send({ method, ...(params ? { params } : {}), sessionId: tab.sessionId });

    if (event.kind === "click") {
      await dispatchTrustedClick(
        send,
        { x: event.x, y: event.y },
        {
          button: event.button,
          doubleClick: event.clickCount >= 2,
          modifiers: event.modifiers,
        },
      );
    } else if (event.kind === "pointer") {
      await dispatchTrustedMousePhase(
        send,
        { x: event.x, y: event.y },
        {
          phase: event.phase,
          button: event.button,
          clickCount: event.clickCount,
          modifiers: event.modifiers,
        },
      );
    } else if (event.kind === "wheel") {
      await dispatchTrustedScroll(send, { x: event.x, y: event.y }, event.deltaX, event.deltaY);
    } else {
      await dispatchTrustedKeyEvent(send, event.key, event.modifiers);
    }

    return { requestId, ok: true, result: { command: "input_at", browserId } };
  }

  private async screencastStart(
    requestId: string,
    args: Extract<BrowserAutomationCommand, { command: "screencast_start" }>["args"],
  ): Promise<BrowserToolsResponsePayload> {
    const tab = this.requireTab(args.browserId);
    // The daemon owns the slot, so a stream left over from an earlier
    // subscription is torn down rather than reused under its old slot.
    await this.stopScreencast(tab);
    await this.send({
      method: "Page.startScreencast",
      params: {
        format: "jpeg",
        quality: args.quality,
        maxWidth: args.maxWidth,
        maxHeight: args.maxHeight,
        everyNthFrame: args.everyNthFrame,
      },
      sessionId: tab.sessionId,
    });
    const screencast: HeadlessScreencast = {
      slot: args.slot,
      quality: args.quality,
      hasEmitted: false,
      firstFrameTimer: null,
    };
    tab.screencast = screencast;
    screencast.firstFrameTimer = setTimeout(() => {
      screencast.firstFrameTimer = null;
      void this.sendFirstScreencastFrame(tab, screencast);
    }, this.firstFrameDelayMs);
    screencast.firstFrameTimer.unref?.();
    return {
      requestId,
      ok: true,
      result: { command: "screencast_start", browserId: args.browserId, slot: args.slot },
    };
  }

  private async screencastStop(
    requestId: string,
    browserId: string,
  ): Promise<BrowserToolsResponsePayload> {
    const tab = this.requireTab(browserId);
    await this.stopScreencast(tab);
    return { requestId, ok: true, result: { command: "screencast_stop", browserId } };
  }

  private async stopScreencast(tab: HeadlessTab): Promise<void> {
    if (!tab.screencast) {
      return;
    }
    clearFirstFrameTimer(tab.screencast);
    tab.screencast = null;
    await this.send({ method: "Page.stopScreencast", sessionId: tab.sessionId });
  }

  /**
   * The capture is silent until the page is damaged, so a still page is painted
   * once from a direct grab, at the stream's own quality so the two frames are
   * indistinguishable to the viewer.
   */
  private async sendFirstScreencastFrame(
    tab: HeadlessTab,
    screencast: HeadlessScreencast,
  ): Promise<void> {
    if (this.disposed || screencast.hasEmitted || tab.screencast !== screencast) {
      return;
    }
    const shot = await this.send({
      method: "Page.captureScreenshot",
      params: { format: "jpeg", quality: screencast.quality },
      sessionId: tab.sessionId,
    }).catch(() => null);
    const metrics = await this.send({
      method: "Page.getLayoutMetrics",
      sessionId: tab.sessionId,
    }).catch(() => null);
    if (this.disposed || screencast.hasEmitted || tab.screencast !== screencast) {
      return;
    }
    const data = shot ? readString(shot.data) : null;
    const viewport =
      metrics && isRecord(metrics.cssVisualViewport) ? metrics.cssVisualViewport : null;
    const deviceWidth = viewport ? readNumber(viewport.clientWidth) : null;
    const deviceHeight = viewport ? readNumber(viewport.clientHeight) : null;
    if (data === null || deviceWidth === null || deviceHeight === null) {
      return;
    }
    screencast.hasEmitted = true;
    this.emitFrame(screencast.slot, { deviceWidth, deviceHeight }, data);
  }

  private handleTargetInfoChanged(event: CdpEvent): void {
    const info = isRecord(event.params.targetInfo) ? event.params.targetInfo : null;
    const targetId = info ? readString(info.targetId) : null;
    if (targetId === null) {
      return;
    }
    for (const tab of this.tabsByBrowserId.values()) {
      if (tab.targetId === targetId) {
        this.sink.announceTabsChanged();
        return;
      }
    }
  }

  private handleCdpEvent(event: CdpEvent): void {
    // The guest navigates on its own too - a link, a redirect, a script - so the
    // tab list is refreshed from Chrome's own notice rather than only after a
    // command this host served, which would leave viewers on a stale title.
    if (event.method === "Target.targetInfoChanged") {
      this.handleTargetInfoChanged(event);
      return;
    }
    if (event.method !== "Page.screencastFrame" || event.sessionId === undefined) {
      return;
    }
    const tab = this.findTabBySessionId(event.sessionId);
    if (!tab?.screencast) {
      return;
    }
    const ackSessionId = readNumber(event.params.sessionId);
    if (ackSessionId === null) {
      return;
    }
    // Chrome stops capturing until the previous frame is acknowledged, so the
    // ack goes out before the frame is inspected.
    void this.send({
      method: "Page.screencastFrameAck",
      params: { sessionId: ackSessionId },
      sessionId: tab.sessionId,
    }).catch(() => {});

    const data = readString(event.params.data);
    const metadata = isRecord(event.params.metadata) ? event.params.metadata : null;
    const deviceWidth = metadata ? readNumber(metadata.deviceWidth) : null;
    const deviceHeight = metadata ? readNumber(metadata.deviceHeight) : null;
    if (data === null || deviceWidth === null || deviceHeight === null) {
      return;
    }
    tab.screencast.hasEmitted = true;
    this.emitFrame(tab.screencast.slot, { deviceWidth, deviceHeight }, data);
  }

  private emitFrame(
    slot: number,
    metadata: { deviceWidth: number; deviceHeight: number },
    dataBase64: string,
  ): void {
    this.sink.handleScreencastFrame({
      frame: {
        opcode: BrowserScreencastOpcode.Frame,
        slot,
        metadata,
        payload: Buffer.from(dataBase64, "base64"),
      },
      sourceClientId: this.clientId,
    });
  }

  private findTabBySessionId(sessionId: string): HeadlessTab | null {
    for (const tab of this.tabsByBrowserId.values()) {
      if (tab.sessionId === sessionId) {
        return tab;
      }
    }
    return null;
  }

  private requireTab(browserId: string): HeadlessTab {
    const tab = this.tabsByBrowserId.get(browserId);
    if (!tab) {
      throw createBrowserToolsRequestError({
        code: "browser_tab_not_found",
        message: `Browser tab ${browserId} is not open in the ${HEADLESS_BROWSER_HOST_KIND}. Call browser_list_tabs and use one of the returned browserId values.`,
      });
    }
    return tab;
  }

  private async readNavigationHistory(tab: HeadlessTab): Promise<CdpNavigationHistory> {
    const result = await this.send({
      method: "Page.getNavigationHistory",
      sessionId: tab.sessionId,
    });
    return readNavigationHistory(result);
  }

  private send(command: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<CdpResult> {
    return this.connection.send(command);
  }
}

interface SyncedHeadlessTab {
  tab: HeadlessTab;
  info: CdpTargetInfo;
}

interface CdpNavigationHistoryEntry {
  id: number;
}

interface CdpNavigationHistory {
  currentIndex: number;
  entries: CdpNavigationHistoryEntry[];
}

function toTabInfo(
  target: SyncedHeadlessTab,
  history: CdpNavigationHistory,
): BrowserAutomationTabInfo {
  return {
    browserId: target.tab.browserId,
    ...(target.tab.workspaceId ? { workspaceId: target.tab.workspaceId } : {}),
    url: target.info.url,
    title: target.info.title,
    // A headless browser has no focused window, so no tab is the active one.
    isActive: false,
    isLoading: false,
    canGoBack: history.currentIndex > 0,
    canGoForward: history.currentIndex < history.entries.length - 1,
  };
}

function readPageTargets(result: CdpResult): CdpTargetInfo[] {
  if (!Array.isArray(result.targetInfos)) {
    return [];
  }
  const infos: CdpTargetInfo[] = [];
  for (const entry of result.targetInfos) {
    if (!isRecord(entry) || entry.type !== "page") {
      continue;
    }
    const targetId = readString(entry.targetId);
    if (targetId === null) {
      continue;
    }
    infos.push({
      targetId,
      url: readString(entry.url) ?? "",
      title: readString(entry.title) ?? "",
    });
  }
  return infos;
}

function readNavigationHistory(result: CdpResult): CdpNavigationHistory {
  const currentIndex = readNumber(result.currentIndex) ?? 0;
  if (!Array.isArray(result.entries)) {
    return { currentIndex, entries: [] };
  }
  const entries: CdpNavigationHistoryEntry[] = [];
  for (const entry of result.entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = readNumber(entry.id);
    if (id === null) {
      continue;
    }
    entries.push({ id });
  }
  return { currentIndex, entries };
}

interface PngSize {
  width: number;
  height: number;
}

/** PNG carries its dimensions in the IHDR chunk, so the bytes answer for themselves. */
function readPngSize(bytes: Buffer): PngSize {
  const hasSignature =
    bytes.byteLength >= 24 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
  if (!hasSignature) {
    throw createBrowserToolsRequestError({
      code: "screenshot_no_frame",
      message: "The browser returned a screenshot that is not a PNG.",
    });
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function clearFirstFrameTimer(screencast: HeadlessScreencast | null): void {
  if (screencast?.firstFrameTimer) {
    clearTimeout(screencast.firstFrameTimer);
    screencast.firstFrameTimer = null;
  }
}

function toFailurePayload(requestId: string, error: unknown): BrowserToolsResponsePayload {
  if (error instanceof BrowserToolsRequestError) {
    return browserToolsFailure({
      requestId,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error instanceof CdpConnectionClosedError || error instanceof CdpConnectError) {
    return browserToolsFailure({
      requestId,
      code: "browser_no_host",
      message: error.message,
      retryable: true,
    });
  }
  if (error instanceof CdpCommandError) {
    return browserToolsFailure({
      requestId,
      code: "browser_unknown_error",
      message: error.message,
    });
  }
  return browserToolsFailure({
    requestId,
    code: "browser_unknown_error",
    message: `The headless browser failed the request: ${String(error)}`,
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
