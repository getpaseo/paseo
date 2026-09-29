import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import {
  type BrowserContext,
  type Dialog,
  type Page,
  type Request,
  type Response,
} from "playwright-core";
import type {
  BrowserAutomationCommand,
  BrowserAutomationCommandName,
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationDialogEvent,
  BrowserAutomationExecuteRequest,
  BrowserAutomationNetworkLogEntry,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserImportCookie } from "@getpaseo/protocol/browser-import/rpc-schemas";
import type {
  BrowserMirrorAction,
  BrowserMirrorEvent,
  BrowserMirrorTarget,
} from "@getpaseo/protocol/browser-activity/rpc-schemas";
import { writeFileAtomic } from "../atomic-file.js";
import type { BrowserHostClient } from "../browser-tools/broker.js";
import {
  browserToolsFailure,
  createBrowserToolsRequestError,
  type BrowserToolsResponsePayload,
} from "../browser-tools/errors.js";
import { resolveBrowserExecutable } from "./browser-capability.js";
import { launchInteractiveBrowser } from "./interactive-browser.js";
import { EvidenceStore, formatEvidenceRef } from "./evidence-store.js";
import {
  collectSnapshotNodes,
  formatSnapshotYaml,
  snapshotRefIndex,
  type CollectedSnapshotNode,
  type SnapshotNodeWithRef,
} from "./page-snapshot.js";

export const DAEMON_PLAYWRIGHT_HOST_ID = "daemon-playwright";
export const DAEMON_PLAYWRIGHT_HOST_KIND = "daemon-playwright";
export const DEFAULT_VERIFY_PROFILE = "default";
export const MAX_VERIFY_LOG_ENTRIES = 200;
const MAX_EVALUATE_JSON_BYTES = 65_536;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const DEFAULT_VERIFY_VIEWPORT = { width: 1280, height: 720 };
const IMPORTED_COOKIES_FILE = "imported-cookies.json";
const IMPORTED_COOKIES_MARKER = ".paseo-imported-cookies-version";
const SHARED_PROFILE_DIR = "shared";
// Caches and Chrome's single-instance locks stay behind when a profile is carried over.
const PROFILE_SEED_SKIP =
  /^(Singleton|Cache$|Code Cache$|GPUCache$|DawnCache$|GrShaderCache$|ShaderCache$)/;

/**
 * Before the shared profile existed every workspace had its own. The first shared launch
 * starts from the most recently used of those, so the logins made there carry over.
 */
export function seedSharedProfile(input: {
  profilesRoot: string;
  userDataDir: string;
  profile: string;
}) {
  if (existsSync(input.userDataDir) || !existsSync(input.profilesRoot)) return;
  let newest: { dir: string; mtimeMs: number } | null = null;
  for (const entry of readdirSync(input.profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === SHARED_PROFILE_DIR) continue;
    const dir = path.join(input.profilesRoot, entry.name, input.profile);
    const cookies = path.join(dir, "Default", "Cookies");
    if (!existsSync(cookies)) continue;
    const mtimeMs = statSync(cookies).mtimeMs;
    if (!newest || mtimeMs > newest.mtimeMs) newest = { dir, mtimeMs };
  }
  if (!newest) return;
  cpSync(newest.dir, input.userDataDir, {
    recursive: true,
    filter: (source) => !PROFILE_SEED_SKIP.test(path.basename(source)),
  });
}
const SAVED_TABS_FILE = "open-tabs.json";
const SAVE_TABS_DELAY_MS = 300;
// A page closing this long after its browser died was lost, not closed by the user.
const LOST_TAB_GRACE_MS = 1_000;
// Measured on a 390x750 phone viewport: q70 costs ~11% more bytes than q60 and keeps text legible.
const SCREENCAST_JPEG_QUALITY = 70;
// A page's copy button writes to the daemon's clipboard, which the person cannot
// reach; remembering the text lets the viewer put it on the clipboard of their device.
const REMEMBER_PAGE_COPIES_SCRIPT = `(() => {
  const remember = (text) => { window.__paseoCopied = { text: String(text), at: Date.now() }; };
  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    const writeText = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text) => { remember(text); return writeText(text).catch(() => undefined); };
  }
  document.addEventListener("copy", () => {
    const selected = String(window.getSelection() ?? "");
    if (selected) remember(selected);
  }, true);
})();`;

interface ImportedCookieStore {
  version: string;
  cookies: BrowserImportCookie[];
}

/** A JPEG viewport frame as Chrome sent it; width and height are CSS pixels. */
export interface ScreencastFrame {
  dataBase64: string;
  width: number;
  height: number;
}

export interface ImportCookiesResult {
  cookieCount: number;
  domainCount: number;
}

export const DAEMON_PLAYWRIGHT_COMMANDS: readonly BrowserAutomationCommandName[] = [
  "list_tabs",
  "new_tab",
  "navigate",
  "back",
  "forward",
  "reload",
  "snapshot",
  "click",
  "fill",
  "select",
  "type",
  "keypress",
  "wait",
  "scroll",
  "hover",
  "drag",
  "resize",
  "screenshot",
  "logs",
  "evaluate",
  "close_tab",
];

type CommandResult = Extract<BrowserToolsResponsePayload, { ok: true }>["result"];

interface VerifyConsoleEntry extends BrowserAutomationConsoleLogEntry {
  timestamp: number;
}

interface VerifyNetworkEntry extends BrowserAutomationNetworkLogEntry {
  failed: boolean;
}

interface SavedTab {
  browserId: string;
  workspaceId: string;
  profile: string;
  url: string;
  /** Null until the tab is reopened in this daemon process. */
  context: BrowserContext | null;
}

interface DaemonBrowserTab {
  browserId: string;
  workspaceId: string;
  profile: string;
  context: BrowserContext;
  page: Page;
  snapshot: SnapshotNodeWithRef[];
  consoleEntries: VerifyConsoleEntry[];
  networkEntries: VerifyNetworkEntry[];
  pendingRequests: Map<Request, number>;
  dialogs: BrowserAutomationDialogEvent[];
}

export interface DaemonPlaywrightHostOptions {
  paseoHome: string;
  logger: Logger;
}

export interface ExecuteLocalInput {
  workspaceId: string;
  command: BrowserAutomationCommand;
  profile?: string;
  requestId?: string;
  agentId?: string;
}

export class DaemonPlaywrightHost {
  private readonly paseoHome: string;
  private readonly logger: Logger;
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly contextProfileDirs = new Map<BrowserContext, string>();
  private readonly tabs = new Map<string, DaemonBrowserTab>();
  // Open tabs outlive a daemon restart: saved on every change, reopened under the same
  // browserId the first time their workspace is used again.
  private readonly savedTabs = new Map<string, SavedTab>();
  private readonly savedTabsLoaded: Promise<void>;
  private readonly restoredWorkspaces = new Map<string, Promise<void>>();
  private saveTabsTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  /** Receives every action on a daemon tab so a desktop app can replay it locally. */
  public onMirror: ((event: BrowserMirrorEvent) => void) | null = null;
  private readonly mirrorQueues = new Map<string, Promise<void>>();
  private executablePath: string | null = null;
  private readonly closeBrowsers = new Map<BrowserContext, () => Promise<void>>();
  private readonly captureQueues = new Map<BrowserContext, Promise<unknown>>();
  private requestSequence = 0;
  private evidenceStore: EvidenceStore | null = null;

  private evidence(): EvidenceStore {
    if (!this.evidenceStore) {
      this.evidenceStore = new EvidenceStore({ paseoHome: this.paseoHome });
    }
    return this.evidenceStore;
  }

  public constructor(options: DaemonPlaywrightHostOptions) {
    this.paseoHome = options.paseoHome;
    this.logger = options.logger;
    this.savedTabsLoaded = this.loadSavedTabs();
  }

  private savedTabsFile(): string {
    return path.join(this.paseoHome, "browser-profiles", SAVED_TABS_FILE);
  }

  private async loadSavedTabs(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.savedTabsFile(), "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const entry of raw as Partial<SavedTab>[]) {
      const { browserId, workspaceId, profile, url } = entry;
      if (typeof browserId !== "string" || typeof workspaceId !== "string") continue;
      if (typeof profile !== "string" || typeof url !== "string") continue;
      if (this.savedTabs.has(browserId)) continue;
      this.savedTabs.set(browserId, { browserId, workspaceId, profile, url, context: null });
    }
  }

  private scheduleSaveTabs(): void {
    if (this.closing || this.saveTabsTimer) return;
    this.saveTabsTimer = setTimeout(() => {
      this.saveTabsTimer = null;
      void this.saveTabs().catch((error: unknown) => {
        this.logger.warn({ err: error }, "Could not save the daemon browser tabs");
      });
    }, SAVE_TABS_DELAY_MS);
  }

  private async saveTabs(): Promise<void> {
    await this.savedTabsLoaded;
    if (this.closing) return;
    const entries = [...this.savedTabs.values()].map(
      ({ browserId, workspaceId, profile, url }) => ({
        browserId,
        workspaceId,
        profile,
        url,
      }),
    );
    mkdirSync(path.dirname(this.savedTabsFile()), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.savedTabsFile(), JSON.stringify(entries, null, 2), { mode: 0o600 });
  }

  private restoreWorkspaceTabs(workspaceId: string): Promise<void> {
    let restoring = this.restoredWorkspaces.get(workspaceId);
    if (!restoring) {
      restoring = this.reopenSavedTabs(workspaceId).catch((error: unknown) => {
        this.logger.warn({ err: error, workspaceId }, "Could not reopen saved browser tabs");
      });
      this.restoredWorkspaces.set(workspaceId, restoring);
    }
    return restoring;
  }

  private async reopenSavedTabs(workspaceId: string): Promise<void> {
    await this.savedTabsLoaded;
    const pending = [...this.savedTabs.values()].filter(
      (saved) =>
        saved.workspaceId === workspaceId && !saved.context && !this.tabs.has(saved.browserId),
    );
    for (const saved of pending) {
      const context = await this.ensureContext({ workspaceId, profile: saved.profile });
      const page = await context.newPage();
      await page.setViewportSize(DEFAULT_VERIFY_VIEWPORT);
      this.registerPage({
        workspaceId,
        profile: saved.profile,
        context,
        page,
        browserId: saved.browserId,
        url: saved.url,
      });
      // Load in the background: one slow or dead site must not hold up the command
      // that woke the workspace.
      void page.goto(saved.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
  }

  private rememberTabUrl(tab: DaemonBrowserTab, url: string): void {
    if (!/^(https?|file):/i.test(url)) return;
    const saved = this.savedTabs.get(tab.browserId);
    if (!saved || saved.url === url) return;
    saved.url = url;
    this.scheduleSaveTabs();
  }

  private forgetTab(browserId: string): void {
    if (this.savedTabs.delete(browserId)) this.scheduleSaveTabs();
  }

  public asHostClient(
    deliver: (response: {
      type: "browser.automation.execute.response";
      payload: BrowserToolsResponsePayload;
    }) => void,
  ): BrowserHostClient {
    return {
      id: DAEMON_PLAYWRIGHT_HOST_ID,
      hostKind: DAEMON_PLAYWRIGHT_HOST_KIND,
      supportedCommands: DAEMON_PLAYWRIGHT_COMMANDS,
      sendBrowserAutomationRequest: (request) => {
        void this.handleBrokerRequest(request).then((payload) =>
          deliver({ type: "browser.automation.execute.response", payload }),
        );
      },
    };
  }

  public async executeLocal(input: ExecuteLocalInput): Promise<BrowserToolsResponsePayload> {
    const requestId = input.requestId ?? `verify_${(this.requestSequence += 1)}`;
    const startedAt = Date.now();
    try {
      const payload = await this.runCommand({
        workspaceId: input.workspaceId,
        command: input.command,
        profile: input.profile ?? DEFAULT_VERIFY_PROFILE,
        requestId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      this.logger.info({
        verifyBrowser: {
          command: input.command.command,
          workspaceId: input.workspaceId,
          durationMs: Date.now() - startedAt,
          ok: payload.ok,
        },
      });
      return payload;
    } catch (error) {
      this.logger.warn({
        verifyBrowser: {
          command: input.command.command,
          workspaceId: input.workspaceId,
          durationMs: Date.now() - startedAt,
          ok: false,
        },
      });
      if (error instanceof StaleRefError) {
        return browserToolsFailure({
          requestId: error.requestId,
          code: "browser_stale_ref",
          message: error.message,
        });
      }
      if (isTimeoutError(error)) {
        return browserToolsFailure({
          requestId,
          code: "browser_timeout",
          message: `Browser automation timed out: ${truncateErrorMessage(error)}`,
          retryable: true,
        });
      }
      return browserToolsFailure({
        requestId,
        code: "browser_unknown_error",
        message: truncateErrorMessage(error),
      });
    }
  }

  /** Streams viewport frames until the returned stop runs; onEnd fires when the tab closes. */
  public async startScreencast(input: {
    workspaceId: string;
    browserId: string;
    jpegQuality?: number;
    maxWidth?: number;
    onFrame: (frame: ScreencastFrame) => void;
    onEnd: () => void;
  }): Promise<() => Promise<void>> {
    await this.restoreWorkspaceTabs(input.workspaceId);
    const tab = this.tabs.get(input.browserId);
    if (!tab || tab.page.isClosed() || tab.workspaceId !== input.workspaceId) {
      throw createBrowserToolsRequestError({
        code: "browser_tab_not_found",
        message: `Browser tab ${input.browserId} is not known to the daemon browser host.`,
      });
    }
    const cdp = await tab.context.newCDPSession(tab.page);
    cdp.on("Page.screencastFrame", (event) => {
      // Ack before pacing: Chrome skips paints while a frame is unacked, so a late ack
      // can drop the last change of a page that then stays still.
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      input.onFrame({
        dataBase64: event.data,
        width: Math.round(event.metadata.deviceWidth),
        height: Math.round(event.metadata.deviceHeight),
      });
    });
    tab.page.once("close", input.onEnd);
    const stop = async () => {
      tab.page.off("close", input.onEnd);
      // Detaching ends the screencast; it rejects once the tab is already gone.
      await cdp.detach().catch(() => {});
    };
    try {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: input.jpegQuality ?? SCREENCAST_JPEG_QUALITY,
        ...(input.maxWidth ? { maxWidth: input.maxWidth } : {}),
      });
    } catch (error) {
      await stop();
      throw error;
    }
    return stop;
  }

  public async close(): Promise<void> {
    this.closing = true;
    if (this.saveTabsTimer) clearTimeout(this.saveTabsTimer);
    this.saveTabsTimer = null;
    this.tabs.clear();
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    this.contextProfileDirs.clear();
    for (const context of contexts) {
      await this.closeBrowsers.get(context)?.();
    }
    this.closeBrowsers.clear();
    this.captureQueues.clear();
  }

  private async handleBrokerRequest(
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserToolsResponsePayload> {
    if (!request.workspaceId) {
      return browserToolsFailure({
        requestId: request.requestId,
        code: "browser_denied",
        message: "The daemon browser host needs a workspace id.",
      });
    }
    return this.executeLocal({
      workspaceId: request.workspaceId,
      command: request.command,
      requestId: request.requestId,
      ...(request.agentId ? { agentId: request.agentId } : {}),
    });
  }

  private async runCommand(input: {
    workspaceId: string;
    command: BrowserAutomationCommand;
    profile: string;
    requestId: string;
    agentId?: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { command, requestId, workspaceId } = input;
    await this.restoreWorkspaceTabs(workspaceId);
    switch (command.command) {
      case "list_tabs":
        return this.listTabs({ workspaceId, requestId });
      case "new_tab": {
        const tab = await this.createTab({
          workspaceId,
          profile: input.profile,
          url: command.args.url,
        });
        return ok(requestId, {
          command: "new_tab",
          browserId: tab.browserId,
          workspaceId: tab.workspaceId,
          url: tab.page.url(),
        });
      }
      default: {
        const tab = this.requireTab({ workspaceId, browserId: command.args.browserId, requestId });
        if ("payload" in tab) {
          return tab.payload;
        }
        const result = await this.runTabCommand({
          tab,
          command,
          requestId,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        });
        const dialogs = takeDialogs(tab);
        return { ...result, ...(dialogs.length > 0 ? { dialogs } : {}) };
      }
    }
  }

  private async runTabCommand(input: {
    tab: DaemonBrowserTab;
    command: BrowserAutomationCommand;
    requestId: string;
    agentId?: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command } = input;
    // Sent before acting: the refs expire once the page changes, and a click's navigation
    // must reach the viewer after the click, not before it.
    const mirror = this.onMirror ? await mirrorActionFor(tab, command) : null;
    if (mirror) this.emitMirror(tab, mirror);
    return this.dispatchTabCommand(input);
  }

  private emitMirror(tab: DaemonBrowserTab, action: BrowserMirrorAction, origin?: string): void {
    this.onMirror?.({
      workspaceId: tab.workspaceId,
      browserId: tab.browserId,
      action,
      at: Date.now(),
      ...(origin ? { origin } : {}),
    });
  }

  /**
   * A person's step in an app's local copy of a daemon tab: repeated on the daemon's page,
   * so agents see what the person did, and passed on to the other apps. A target this page
   * lacks is skipped, like on the apps.
   */
  public applyMirrorAction(input: {
    workspaceId: string;
    browserId: string;
    action: BrowserMirrorAction;
    origin: string;
  }): Promise<void> {
    // One tab's steps run in the order they were made: Enter must not overtake the typing.
    const previous = this.mirrorQueues.get(input.browserId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.applyMirrorActionNow(input));
    this.mirrorQueues.set(input.browserId, next);
    void next.finally(() => {
      if (this.mirrorQueues.get(input.browserId) === next)
        this.mirrorQueues.delete(input.browserId);
    });
    return next;
  }

  private async applyMirrorActionNow(input: {
    workspaceId: string;
    browserId: string;
    action: BrowserMirrorAction;
    origin: string;
  }): Promise<void> {
    await this.restoreWorkspaceTabs(input.workspaceId);
    const tab = this.tabs.get(input.browserId);
    if (!tab || tab.page.isClosed() || tab.workspaceId !== input.workspaceId) return;
    this.emitMirror(tab, await withoutSecret(tab, input.action), input.origin);
    await performMirrorAction(tab.page, input.action).catch(() => undefined);
    invalidateSnapshot(tab);
  }

  private async dispatchTabCommand(input: {
    tab: DaemonBrowserTab;
    command: BrowserAutomationCommand;
    requestId: string;
    agentId?: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    switch (command.command) {
      case "navigate":
      case "back":
      case "forward":
      case "reload":
        return this.runNavigationCommand({ tab, command, requestId });
      case "snapshot":
        return this.runSnapshotCommand({ tab, requestId });
      case "click":
      case "fill":
      case "select":
      case "hover":
      case "drag":
        return this.runRefCommand({ tab, command, requestId });
      case "type":
      case "keypress":
      case "scroll":
        return this.runKeyCommand({ tab, command, requestId });
      default:
        return this.runOutputCommand({
          tab,
          command,
          requestId,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        });
    }
  }

  private async runNavigationCommand(input: {
    tab: DaemonBrowserTab;
    command: Extract<
      BrowserAutomationCommand,
      { command: "navigate" | "back" | "forward" | "reload" }
    >;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    switch (command.command) {
      case "navigate":
        await tab.page.goto(command.args.url, { waitUntil: "domcontentloaded" });
        invalidateSnapshot(tab);
        return ok(requestId, {
          command: "navigate",
          browserId: tab.browserId,
          url: tab.page.url(),
        });
      case "back":
        await tab.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
        invalidateSnapshot(tab);
        return ok(requestId, { command: "back", browserId: tab.browserId });
      case "forward":
        await tab.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
        invalidateSnapshot(tab);
        return ok(requestId, { command: "forward", browserId: tab.browserId });
      case "reload":
        await tab.page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
        invalidateSnapshot(tab);
        return ok(requestId, { command: "reload", browserId: tab.browserId });
    }
  }

  private async runSnapshotCommand(input: {
    tab: DaemonBrowserTab;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, requestId } = input;
    const snapshot = await this.refreshSnapshot(tab);
    return ok(requestId, {
      command: "snapshot",
      browserId: tab.browserId,
      workspaceId: tab.workspaceId,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      format: "aria-yaml",
      snapshot: snapshot.yaml,
      truncated: snapshot.truncated,
      stats: snapshot.stats,
    });
  }

  private async runRefCommand(input: {
    tab: DaemonBrowserTab;
    command: Extract<
      BrowserAutomationCommand,
      { command: "click" | "fill" | "select" | "hover" | "drag" }
    >;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    switch (command.command) {
      case "click":
        if ("ref" in command.args) {
          await tab.page.locator(resolveRefSelector(tab, command.args.ref, requestId)).click();
          invalidateSnapshot(tab);
          return ok(requestId, {
            command: "click",
            browserId: tab.browserId,
            ref: command.args.ref,
          });
        }
        if (!("x" in command.args) || !("y" in command.args)) {
          return browserToolsFailure({
            requestId,
            code: "browser_unknown_error",
            message: "The browser click command has no target coordinates.",
          });
        }
        const { button, doubleClick, modifiers, x, y } = command.args;
        await withKeyboardModifiers(tab.page, modifiers, async () => {
          await tab.page.mouse.click(x, y, { button, clickCount: doubleClick ? 2 : 1 });
        });
        invalidateSnapshot(tab);
        return ok(requestId, {
          command: "click",
          browserId: tab.browserId,
          x,
          y,
        });
      case "fill":
        await tab.page
          .locator(resolveRefSelector(tab, command.args.ref, requestId))
          .fill(command.args.value);
        return ok(requestId, { command: "fill", browserId: tab.browserId, ref: command.args.ref });
      case "select":
        await tab.page
          .locator(resolveRefSelector(tab, command.args.ref, requestId))
          .selectOption(command.args.value);
        return ok(requestId, {
          command: "select",
          browserId: tab.browserId,
          ref: command.args.ref,
          value: command.args.value,
        });
      case "hover":
        if ("ref" in command.args) {
          await tab.page.locator(resolveRefSelector(tab, command.args.ref, requestId)).hover();
          return ok(requestId, {
            command: "hover",
            browserId: tab.browserId,
            ref: command.args.ref,
          });
        }
        await tab.page.mouse.move(command.args.x, command.args.y);
        return ok(requestId, {
          command: "hover",
          browserId: tab.browserId,
          x: command.args.x,
          y: command.args.y,
        });
      case "drag":
        if ("sourceRef" in command.args) {
          await tab.page
            .locator(resolveRefSelector(tab, command.args.sourceRef, requestId))
            .dragTo(tab.page.locator(resolveRefSelector(tab, command.args.targetRef, requestId)));
          invalidateSnapshot(tab);
          return ok(requestId, {
            command: "drag",
            browserId: tab.browserId,
            sourceRef: command.args.sourceRef,
            targetRef: command.args.targetRef,
          });
        }
        await tab.page.mouse.move(command.args.sourceX, command.args.sourceY);
        await tab.page.mouse.down();
        try {
          await tab.page.mouse.move(command.args.targetX, command.args.targetY, { steps: 8 });
        } finally {
          await tab.page.mouse.up();
        }
        invalidateSnapshot(tab);
        return ok(requestId, {
          command: "drag",
          browserId: tab.browserId,
          sourceX: command.args.sourceX,
          sourceY: command.args.sourceY,
          targetX: command.args.targetX,
          targetY: command.args.targetY,
        });
    }
  }

  private async runKeyCommand(input: {
    tab: DaemonBrowserTab;
    command: Extract<BrowserAutomationCommand, { command: "type" | "keypress" | "scroll" }>;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    switch (command.command) {
      case "type":
        if (command.args.ref) {
          await tab.page
            .locator(resolveRefSelector(tab, command.args.ref, requestId))
            .pressSequentially(command.args.text);
        } else {
          await tab.page.keyboard.type(command.args.text);
        }
        invalidateSnapshot(tab);
        return ok(requestId, {
          command: "type",
          browserId: tab.browserId,
          ...(command.args.ref ? { ref: command.args.ref } : {}),
        });
      case "keypress":
        if (command.args.ref) {
          await tab.page
            .locator(resolveRefSelector(tab, command.args.ref, requestId))
            .press(command.args.key);
        } else {
          await tab.page.keyboard.press(command.args.key);
        }
        invalidateSnapshot(tab);
        return ok(requestId, {
          command: "keypress",
          browserId: tab.browserId,
          key: command.args.key,
          ...(command.args.ref ? { ref: command.args.ref } : {}),
        });
      case "scroll":
        if (command.args.x !== undefined && command.args.y !== undefined) {
          await tab.page.mouse.move(command.args.x, command.args.y);
        }
        if (command.args.ref) {
          await tab.page
            .locator(resolveRefSelector(tab, command.args.ref, requestId))
            .scrollIntoViewIfNeeded();
        }
        await tab.page.mouse.wheel(command.args.deltaX, command.args.deltaY);
        return ok(requestId, {
          command: "scroll",
          browserId: tab.browserId,
          ...(command.args.ref ? { ref: command.args.ref } : {}),
          deltaX: command.args.deltaX,
          deltaY: command.args.deltaY,
          ...(command.args.x !== undefined && command.args.y !== undefined
            ? { x: command.args.x, y: command.args.y }
            : {}),
        });
    }
  }

  private async runOutputCommand(input: {
    tab: DaemonBrowserTab;
    command: Extract<
      BrowserAutomationCommand,
      {
        command:
          | "wait"
          | "resize"
          | "screenshot"
          | "logs"
          | "evaluate"
          | "close_tab"
          | "list_tabs"
          | "new_tab"
          | "upload";
      }
    >;
    requestId: string;
    agentId?: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    switch (command.command) {
      case "wait":
        return this.runWaitCommand({ tab, command, requestId });
      case "resize":
        return this.runResizeCommand({ tab, command, requestId });
      case "screenshot":
        return this.runScreenshotCommand({
          tab,
          command,
          requestId,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        });
      case "logs":
        return this.runLogsCommand({ tab, command, requestId });
      case "evaluate":
        return this.runEvaluateCommand({ tab, command, requestId });
      case "close_tab":
        return this.runCloseTabCommand({ tab, requestId });
      case "list_tabs":
      case "new_tab":
      case "upload":
        return browserToolsFailure({
          requestId,
          code: "browser_unsupported",
          message: `The daemon browser host does not support "${command.command}".`,
        });
    }
  }
  private async runWaitCommand(input: {
    tab: DaemonBrowserTab;
    command: Extract<BrowserAutomationCommand, { command: "wait" }>;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    const matched = await this.waitForCondition(tab, command.args);
    return ok(requestId, { command: "wait", browserId: tab.browserId, matched });
  }

  private async runResizeCommand(input: {
    tab: DaemonBrowserTab;
    command: Extract<BrowserAutomationCommand, { command: "resize" }>;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    await tab.page.setViewportSize({ width: command.args.width, height: command.args.height });
    return ok(requestId, {
      command: "resize",
      browserId: tab.browserId,
      width: command.args.width,
      height: command.args.height,
    });
  }

  private async runScreenshotCommand(input: {
    tab: DaemonBrowserTab;
    command: Extract<BrowserAutomationCommand, { command: "screenshot" }>;
    requestId: string;
    agentId?: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    const data = await this.captureScreenshot(tab, command.args.fullPage);
    if (command.args.ephemeral) {
      const viewport = tab.page.viewportSize() ?? DEFAULT_VERIFY_VIEWPORT;
      return ok(requestId, {
        command: "screenshot",
        browserId: tab.browserId,
        mimeType: "image/png",
        dataBase64: data.toString("base64"),
        bytes: data.byteLength,
        width: viewport.width,
        height: viewport.height,
      });
    }
    // Capture time, not write time: with a capture retry the two differ,
    // and the timeline anchor must point at the moment the pixels existed.
    const capturedAt = new Date().toISOString();
    const viewport = tab.page.viewportSize() ?? DEFAULT_VERIFY_VIEWPORT;
    const workspaceId = tab.workspaceId;
    let runId = command.args.runId;
    if (runId) {
      const manifest = await this.evidence().getManifest({ workspaceId, runId });
      if (!manifest) {
        return browserToolsFailure({
          requestId,
          code: "browser_unknown_error",
          message: `Evidence run not found: ${runId}`,
        });
      }
    } else {
      const manifest = await this.evidence().createRun({
        workspaceId,
        recipe: "browser-screenshot",
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      runId = manifest.runId;
    }
    const name = command.args.artifactName ?? "screenshot";
    const entry = await this.evidence().writeArtifact({
      runId,
      name,
      kind: "screenshot",
      contentType: "image/png",
      data,
      capturedAt,
    });
    return ok(requestId, {
      command: "screenshot",
      browserId: tab.browserId,
      mimeType: "image/png",
      ...(command.args.reveal ? { dataBase64: data.toString("base64") } : {}),
      evidenceRef: formatEvidenceRef({ workspaceId, runId, name }),
      bytes: entry.bytes,
      sha256: entry.sha256,
      width: viewport.width,
      height: viewport.height,
    });
  }

  private async captureScreenshot(tab: DaemonBrowserTab, fullPage: boolean): Promise<Buffer> {
    const previous = this.captureQueues.get(tab.context) ?? Promise.resolve();
    const capture = previous
      .catch(() => undefined)
      .then(async () => {
        // A background tab can retain its old compositor surface after navigation.
        // Serialize activation with capture so another tab cannot hide it midway.
        await tab.page.bringToFront();
        await waitForPaint(tab.page);
        return tab.page.screenshot({ fullPage, timeout: 5_000 });
      });
    this.captureQueues.set(tab.context, capture);
    return capture;
  }

  private async runLogsCommand(input: {
    tab: DaemonBrowserTab;
    command: Extract<BrowserAutomationCommand, { command: "logs" }>;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    const maxEntries = command.args.maxEntries;
    return ok(requestId, {
      command: "logs",
      browserId: tab.browserId,
      console: tab.consoleEntries.slice(-maxEntries),
      network: tab.networkEntries.slice(-maxEntries).map(stripNetworkFailed),
    });
  }

  private async runEvaluateCommand(input: {
    tab: DaemonBrowserTab;
    command: Extract<BrowserAutomationCommand, { command: "evaluate" }>;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, command, requestId } = input;
    const { resultJson, truncated } = await this.evaluateInPage(
      tab,
      command.args.function,
      command.args.ref,
    );
    return ok(requestId, { command: "evaluate", browserId: tab.browserId, resultJson, truncated });
  }

  private async runCloseTabCommand(input: {
    tab: DaemonBrowserTab;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const { tab, requestId } = input;
    const browserId = tab.browserId;
    this.forgetTab(browserId);
    await tab.page.close().catch(() => undefined);
    this.tabs.delete(browserId);
    return ok(requestId, { command: "close_tab", browserId });
  }

  private async listTabs(input: {
    workspaceId: string;
    requestId: string;
  }): Promise<BrowserToolsResponsePayload> {
    const tabs = [];
    for (const tab of this.tabs.values()) {
      if (tab.workspaceId !== input.workspaceId || tab.page.isClosed()) {
        continue;
      }
      tabs.push({
        browserId: tab.browserId,
        workspaceId: tab.workspaceId,
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ""),
        isActive: true,
        isLoading: false,
      });
    }
    return ok(input.requestId, { command: "list_tabs", tabs });
  }

  private requireTab(input: {
    workspaceId: string;
    browserId: string;
    requestId: string;
  }): DaemonBrowserTab | { payload: BrowserToolsResponsePayload } {
    const tab = this.tabs.get(input.browserId);
    if (!tab || tab.page.isClosed()) {
      if (tab) {
        this.tabs.delete(input.browserId);
      }
      return {
        payload: browserToolsFailure({
          requestId: input.requestId,
          code: "browser_tab_not_found",
          message: `Browser tab ${input.browserId} is not known to the daemon browser host.`,
        }),
      };
    }
    if (tab.workspaceId !== input.workspaceId) {
      return {
        payload: browserToolsFailure({
          requestId: input.requestId,
          code: "browser_denied",
          message: "Browser tab belongs to a different workspace.",
          retryable: false,
        }),
      };
    }
    return tab;
  }

  private async createTab(input: {
    workspaceId: string;
    profile: string;
    url?: string;
  }): Promise<DaemonBrowserTab> {
    const context = await this.ensureContext({
      workspaceId: input.workspaceId,
      profile: input.profile,
    });
    const page = await context.newPage();
    await page.setViewportSize(DEFAULT_VERIFY_VIEWPORT);
    const tab = this.registerPage({ ...input, context, page });
    if (input.url) {
      await page.goto(input.url, { waitUntil: "domcontentloaded" });
    }
    await page.bringToFront();
    // Normal Chrome keeps paint holding enabled; input before its first frame
    // can be dropped even though DOMContentLoaded already fired.
    await waitForPaint(page);
    return tab;
  }

  private registerPage(input: {
    workspaceId: string;
    profile: string;
    context: BrowserContext;
    page: Page;
    browserId?: string;
    url?: string;
  }): DaemonBrowserTab {
    const existing = [...this.tabs.values()].find((tab) => tab.page === input.page);
    if (existing) {
      // newPage() announces the page before a restore can name it; take the saved id.
      if (input.browserId && existing.browserId !== input.browserId) {
        this.tabs.delete(existing.browserId);
        this.savedTabs.delete(existing.browserId);
        existing.browserId = input.browserId;
        this.tabs.set(existing.browserId, existing);
        this.saveTab(existing, input.url);
      }
      return existing;
    }
    const browserId =
      input.browserId ?? `${Date.now().toString()}-${randomBytes(8).toString("hex")}`;
    const tab: DaemonBrowserTab = {
      browserId,
      workspaceId: input.workspaceId,
      profile: input.profile,
      context: input.context,
      page: input.page,
      snapshot: [],
      consoleEntries: [],
      networkEntries: [],
      pendingRequests: new Map(),
      dialogs: [],
    };
    attachTabListeners(tab);
    this.tabs.set(browserId, tab);
    this.saveTab(tab, input.url);
    let mirroredUrl = "";
    input.page.on("framenavigated", (frame) => {
      if (frame !== input.page.mainFrame()) return;
      const url = frame.url();
      this.rememberTabUrl(tab, url);
      // Link clicks, redirects and history moves all land here, not only navigate.
      if (url !== mirroredUrl && /^(https?|file):/i.test(url)) {
        mirroredUrl = url;
        this.emitMirror(tab, { kind: "navigate", url });
      }
    });
    input.page.once("close", () => {
      if (this.tabs.get(tab.browserId) === tab) this.tabs.delete(tab.browserId);
      setTimeout(() => {
        if (!this.closing && [...this.contexts.values()].includes(tab.context)) {
          this.forgetTab(tab.browserId);
        }
      }, LOST_TAB_GRACE_MS);
    });
    return tab;
  }

  private saveTab(tab: DaemonBrowserTab, url: string | undefined): void {
    this.savedTabs.set(tab.browserId, {
      browserId: tab.browserId,
      workspaceId: tab.workspaceId,
      profile: tab.profile,
      url: url ?? this.savedTabs.get(tab.browserId)?.url ?? "about:blank",
      context: tab.context,
    });
    this.rememberTabUrl(tab, tab.page.url());
    this.scheduleSaveTabs();
  }

  private async refreshSnapshot(tab: DaemonBrowserTab): Promise<{
    yaml: string;
    truncated: boolean;
    stats: { nodeCount: number; refCount: number; textLength: number };
  }> {
    // Playwright serializes this function into the page, where the tsx/esbuild
    // __name() helper does not exist. Strip those calls before evaluating.
    const snapshotSource = collectSnapshotNodes.toString().replace(/__name\([^;]*\);?/g, "");
    const collected = (await tab.page.evaluate(`(${snapshotSource})()`)) as CollectedSnapshotNode[];
    const formatted = formatSnapshotYaml(collected);
    tab.snapshot = formatted.nodes;
    return { yaml: formatted.yaml, truncated: formatted.truncated, stats: formatted.stats };
  }

  private async waitForCondition(
    tab: DaemonBrowserTab,
    args: { text?: string; url?: string; timeoutMs?: number },
  ): Promise<"text" | "url"> {
    const timeout = args.timeoutMs ?? 15_000;
    if (args.text !== undefined) {
      const expected = JSON.stringify(args.text);
      await tab.page.waitForFunction(
        `document.body && document.body.innerText.includes(${expected})`,
        undefined,
        { timeout },
      );
      invalidateSnapshot(tab);
      return "text";
    }
    const expected = args.url ?? "";
    await tab.page.waitForURL((current) => current.toString().includes(expected), { timeout });
    invalidateSnapshot(tab);
    return "url";
  }

  private async evaluateInPage(
    tab: DaemonBrowserTab,
    functionSource: string,
    ref: string | undefined,
  ): Promise<{ resultJson: string; truncated: boolean }> {
    const selector = ref ? resolveRefSelector(tab, ref, "evaluate") : undefined;
    const raw = await tab.page.evaluate(
      async ({ source, elementSelector }) => {
        const userFunction = new Function(`return (${source})`)();
        if (typeof userFunction !== "function") {
          throw new Error("browser_evaluate input must evaluate to a function.");
        }
        if (!elementSelector) {
          return userFunction();
        }
        const element = document.querySelector(elementSelector);
        if (!element) {
          throw new Error("The referenced browser element is no longer available.");
        }
        return userFunction(element);
      },
      { source: functionSource, elementSelector: selector ?? null },
    );
    const resultJson = JSON.stringify(raw ?? null) ?? "null";
    if (Buffer.byteLength(resultJson, "utf8") <= MAX_EVALUATE_JSON_BYTES) {
      return { resultJson, truncated: false };
    }
    return { resultJson: resultJson.slice(0, MAX_EVALUATE_JSON_BYTES), truncated: true };
  }

  private async ensureContext(input: {
    workspaceId: string;
    profile: string;
  }): Promise<BrowserContext> {
    // One Chrome profile for every workspace: a login made once holds everywhere, and new
    // workspaces (Paperclip opens one per feature) do not start signed out.
    const key = input.profile;
    const existing = this.contexts.get(key);
    if (existing) {
      return existing;
    }
    if (!this.executablePath) {
      this.executablePath = resolveBrowserExecutable().path;
    }
    const userDataDir = path.join(
      this.paseoHome,
      "browser-profiles",
      SHARED_PROFILE_DIR,
      sanitizeProfileSegment(input.profile),
    );
    seedSharedProfile({
      profilesRoot: path.join(this.paseoHome, "browser-profiles"),
      userDataDir,
      profile: sanitizeProfileSegment(input.profile),
    });
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const context = await this.launchPersistentContext(userDataDir);
    await context.addInitScript(REMEMBER_PAGE_COPIES_SCRIPT);
    this.contexts.set(key, context);
    this.contextProfileDirs.set(context, userDataDir);
    // OAuth providers can open a popup; it belongs to the workspace of the tab that opened it.
    // Pages the host opens itself are registered by their caller with the right workspace.
    context.on("page", (page) => {
      void page.opener().then((opener) => {
        const openerTab = opener
          ? [...this.tabs.values()].find((tab) => tab.page === opener)
          : null;
        if (openerTab) {
          this.registerPage({
            workspaceId: openerTab.workspaceId,
            profile: input.profile,
            context,
            page,
          });
        }
        return undefined;
      });
    });
    context.on("close", () => {
      this.contextProfileDirs.delete(context);
      this.closeBrowsers.delete(context);
      this.captureQueues.delete(context);
      if (this.contexts.get(key) === context) {
        this.contexts.delete(key);
      }
    });
    const store = await this.readImportedCookieStore();
    if (store) {
      await this.applyImportedCookies({ context, userDataDir, store });
    }
    return context;
  }

  /**
   * Merges cookies into the host-wide import store and applies them to every open profile.
   * Profiles launched later pick the store up once, tracked by a version marker in their
   * userDataDir, so cookies the site rotates afterwards are not overwritten on each launch.
   */
  public async importCookies(cookies: BrowserImportCookie[]): Promise<ImportCookiesResult> {
    const nowSeconds = Date.now() / 1000;
    const merged = new Map<string, BrowserImportCookie>();
    for (const cookie of [...((await this.readImportedCookieStore())?.cookies ?? []), ...cookies]) {
      if (cookie.expires !== -1 && cookie.expires < nowSeconds) continue;
      merged.set(`${cookie.domain}\t${cookie.path}\t${cookie.name}`, cookie);
    }
    const store: ImportedCookieStore = { version: randomUUID(), cookies: [...merged.values()] };
    await writeFileAtomic(this.importedCookieStorePath(), JSON.stringify(store), { mode: 0o600 });
    for (const [context, userDataDir] of this.contextProfileDirs) {
      await this.applyImportedCookies({ context, userDataDir, store });
    }
    return {
      cookieCount: cookies.length,
      domainCount: new Set(cookies.map((cookie) => cookie.domain.replace(/^\./, ""))).size,
    };
  }

  private importedCookieStorePath(): string {
    return path.join(this.paseoHome, "browser-profiles", IMPORTED_COOKIES_FILE);
  }

  private async readImportedCookieStore(): Promise<ImportedCookieStore | null> {
    const raw = await readFile(this.importedCookieStorePath(), "utf8").catch(() => null);
    return raw ? (JSON.parse(raw) as ImportedCookieStore) : null;
  }

  private async applyImportedCookies(input: {
    context: BrowserContext;
    userDataDir: string;
    store: ImportedCookieStore;
  }): Promise<void> {
    const markerPath = path.join(input.userDataDir, IMPORTED_COOKIES_MARKER);
    const applied = await readFile(markerPath, "utf8").catch(() => null);
    if (applied === input.store.version) return;
    try {
      await input.context.addCookies(input.store.cookies);
    } catch {
      // One cookie Chromium rejects fails the whole batch; retry singly and drop the rejects.
      let rejected = 0;
      for (const cookie of input.store.cookies) {
        await input.context.addCookies([cookie]).catch(() => {
          rejected += 1;
        });
      }
      this.logger.warn({ rejected }, "Chromium rejected some imported cookies");
    }
    await writeFile(markerPath, input.store.version);
  }

  private async launchPersistentContext(userDataDir: string): Promise<BrowserContext> {
    const browser = await launchInteractiveBrowser({
      executablePath: this.executablePath!,
      userDataDir,
    });
    this.closeBrowsers.set(browser.context, browser.close);
    return browser.context;
  }
}

async function waitForPaint(page: Page): Promise<void> {
  await page.waitForFunction(
    "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
    undefined,
    { timeout: 5_000 },
  );
}

function ok(requestId: string, result: CommandResult): BrowserToolsResponsePayload {
  return { requestId, ok: true, result };
}

const MIRROR_ACTION_TIMEOUT_MS = 3_000;

/** A password typed in one app reaches the daemon's page but no other app. */
async function withoutSecret(
  tab: DaemonBrowserTab,
  action: BrowserMirrorAction,
): Promise<BrowserMirrorAction> {
  if (action.kind !== "fill" && action.kind !== "type") return action;
  if (!(await isPasswordField(tab, action.target ?? null))) return action;
  if (action.kind === "fill") return { kind: "fill", target: action.target };
  return { kind: "type", ...(action.target ? { target: action.target } : {}) };
}

function mirrorLocator(page: Page, target: BrowserMirrorTarget) {
  const bySelector = page.locator(target.selector).first();
  if (!target.role || !target.name) return bySelector;
  const byRole = page
    .getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true })
    .first();
  return bySelector.or(byRole).first();
}

async function performMirrorAction(page: Page, action: BrowserMirrorAction): Promise<void> {
  const timeout = MIRROR_ACTION_TIMEOUT_MS;
  const target = "target" in action && action.target ? mirrorLocator(page, action.target) : null;
  switch (action.kind) {
    case "navigate":
      if (page.url() !== action.url) await page.goto(action.url, { waitUntil: "domcontentloaded" });
      return;
    case "click":
      await (action.doubleClick ? target?.dblclick({ timeout }) : target?.click({ timeout }));
      return;
    case "fill":
      if (action.value !== undefined) await target?.fill(action.value, { timeout });
      return;
    case "select":
      await target?.selectOption(action.value, { timeout });
      return;
    case "type":
      if (action.text === undefined) return;
      await (target
        ? target.pressSequentially(action.text, { timeout })
        : page.keyboard.type(action.text));
      return;
    case "keypress":
      await (target ? target.press(action.key, { timeout }) : page.keyboard.press(action.key));
      return;
    case "scroll":
      await page.mouse.wheel(action.deltaX, action.deltaY);
      return;
  }
}

function mirrorTarget(tab: DaemonBrowserTab, ref: string | undefined): BrowserMirrorTarget | null {
  if (!ref) return null;
  const index = snapshotRefIndex(ref);
  const node = index === null ? undefined : tab.snapshot[index];
  if (!node || node.ref !== ref) return null;
  return { selector: node.selector, role: node.role, ...(node.name ? { name: node.name } : {}) };
}

async function isPasswordField(tab: DaemonBrowserTab, target: BrowserMirrorTarget | null) {
  if (!target) {
    // Keyboard input without a ref goes to whatever has focus.
    const focused = await tab.page
      .evaluate("document.activeElement && document.activeElement.type")
      .catch(() => null);
    return String(focused).toLowerCase() === "password";
  }
  const type = await tab.page
    .locator(target.selector)
    .first()
    .getAttribute("type", { timeout: 500 })
    .catch(() => null);
  return type?.toLowerCase() === "password";
}

/**
 * The DOM-level form of a command, for replay in another browser. Coordinate input has no
 * element to name there, and navigation is reported from the page itself, so both are left out.
 */
async function mirrorActionFor(
  tab: DaemonBrowserTab,
  command: BrowserAutomationCommand,
): Promise<BrowserMirrorAction | null> {
  const args = command.args as Record<string, unknown>;
  const target = mirrorTarget(tab, typeof args.ref === "string" ? args.ref : undefined);
  switch (command.command) {
    case "click":
    case "fill":
    case "select":
      return target ? elementAction(tab, command.command, target, args) : null;
    case "type":
    case "keypress":
    case "scroll":
      return keyAction(tab, command.command, target, args);
    default:
      return null;
  }
}

async function elementAction(
  tab: DaemonBrowserTab,
  kind: "click" | "fill" | "select",
  target: BrowserMirrorTarget,
  args: Record<string, unknown>,
): Promise<BrowserMirrorAction> {
  if (kind === "click") return { kind, target, ...(args.doubleClick ? { doubleClick: true } : {}) };
  if (kind === "select") return { kind, target, value: String(args.value ?? "") };
  return (await isPasswordField(tab, target))
    ? { kind, target }
    : { kind, target, value: String(args.value ?? "") };
}

async function keyAction(
  tab: DaemonBrowserTab,
  kind: "type" | "keypress" | "scroll",
  target: BrowserMirrorTarget | null,
  args: Record<string, unknown>,
): Promise<BrowserMirrorAction> {
  const at = target ? { target } : {};
  if (kind === "keypress") return { kind, ...at, key: String(args.key ?? "") };
  if (kind === "scroll") {
    return { kind, ...at, deltaX: Number(args.deltaX ?? 0), deltaY: Number(args.deltaY ?? 0) };
  }
  const secret = await isPasswordField(tab, target);
  return { kind, ...at, ...(secret ? {} : { text: String(args.text ?? "") }) };
}

function invalidateSnapshot(tab: DaemonBrowserTab): void {
  tab.snapshot = [];
}

function resolveRefSelector(tab: DaemonBrowserTab, ref: string, requestId: string): string {
  const index = snapshotRefIndex(ref);
  const node = index === null ? undefined : tab.snapshot[index];
  if (!node || node.ref !== ref) {
    throw new StaleRefError(requestId, ref);
  }
  return node.selector;
}

export class StaleRefError extends Error {
  public readonly requestId: string;
  public readonly ref: string;

  public constructor(requestId: string, ref: string) {
    super(`Reference ${ref} expired; take a fresh browser_snapshot before acting.`);
    this.name = "StaleRefError";
    this.requestId = requestId;
    this.ref = ref;
  }
}

function takeDialogs(tab: DaemonBrowserTab): BrowserAutomationDialogEvent[] {
  if (tab.dialogs.length === 0) {
    return [];
  }
  const dialogs = [...tab.dialogs];
  tab.dialogs.length = 0;
  return dialogs;
}

function stripNetworkFailed(entry: VerifyNetworkEntry): BrowserAutomationNetworkLogEntry {
  const { failed: _failed, ...rest } = entry;
  return rest;
}

function toDialogType(value: string): BrowserAutomationDialogEvent["type"] {
  return value === "alert" || value === "confirm" || value === "prompt" || value === "beforeunload"
    ? value
    : "alert";
}

function attachTabListeners(tab: DaemonBrowserTab): void {
  const { page } = tab;
  page.on("console", (message) => {
    pushConsole(tab, {
      level: message.type(),
      message: truncateLogText(message.text()),
      source: message.location().url || undefined,
      line: message.location().lineNumber || undefined,
      timestamp: Date.now(),
    });
  });
  page.on("pageerror", (error) => {
    pushConsole(tab, {
      level: "error",
      message: truncateLogText(error instanceof Error ? error.message : String(error)),
      timestamp: Date.now(),
    });
  });
  page.on("request", (request) => {
    tab.pendingRequests.set(request, Date.now());
  });
  const finishRequest = (request: Request, response: Response | null, failed: boolean) => {
    const startTime = tab.pendingRequests.get(request) ?? Date.now();
    tab.pendingRequests.delete(request);
    pushNetwork(tab, {
      url: request.url(),
      method: request.method(),
      ...(response ? { status: response.status() } : {}),
      type: request.resourceType(),
      startTime,
      duration: Date.now() - startTime,
      failed,
    });
  };
  page.on("response", (response) => {
    if (response.status() >= 400) {
      finishRequest(response.request(), response, false);
    } else {
      tab.pendingRequests.delete(response.request());
    }
  });
  page.on("requestfailed", (request) => {
    finishRequest(request, null, true);
  });
  page.on("dialog", (dialog: Dialog) => {
    tab.dialogs.push({
      type: toDialogType(dialog.type()),
      message: truncateLogText(dialog.message()),
      ...(dialog.defaultValue().length > 0 ? { defaultValue: dialog.defaultValue() } : {}),
      action: "dismissed",
      timestamp: Date.now(),
    });
    void dialog.dismiss().catch(() => undefined);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      invalidateSnapshot(tab);
    }
  });
}

function pushConsole(tab: DaemonBrowserTab, entry: VerifyConsoleEntry): void {
  tab.consoleEntries.push(entry);
  if (tab.consoleEntries.length > MAX_VERIFY_LOG_ENTRIES) {
    tab.consoleEntries.splice(0, tab.consoleEntries.length - MAX_VERIFY_LOG_ENTRIES);
  }
}

function pushNetwork(tab: DaemonBrowserTab, entry: VerifyNetworkEntry): void {
  tab.networkEntries.push(entry);
  if (tab.networkEntries.length > MAX_VERIFY_LOG_ENTRIES) {
    tab.networkEntries.splice(0, tab.networkEntries.length - MAX_VERIFY_LOG_ENTRIES);
  }
}

function truncateLogText(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

async function withKeyboardModifiers(
  page: Page,
  modifiers: readonly string[],
  action: () => Promise<void>,
): Promise<void> {
  for (const modifier of modifiers) {
    await page.keyboard.down(modifier);
  }
  try {
    await action();
  } finally {
    for (const modifier of modifiers.toReversed()) {
      await page.keyboard.up(modifier);
    }
  }
}

function truncateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;
}

function sanitizeProfileSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return sanitized.length > 0 ? sanitized : "profile";
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "TimeoutError" || /timeout|exceeded/i.test(error.message);
}

export function consoleErrors(entries: readonly VerifyConsoleEntry[]): VerifyConsoleEntry[] {
  return entries.filter((entry) => entry.level === "error");
}

export function failedNetworkRequests(
  entries: readonly VerifyNetworkEntry[],
): VerifyNetworkEntry[] {
  return entries.filter(
    (entry) => entry.failed || (entry.status !== undefined && entry.status >= 400),
  );
}
