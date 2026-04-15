/**
 * ClientBrowserManager — delegates browser operations to the connected client's webview
 * instead of running a local Playwright headless browser.
 *
 * When a client with a webview is connected, MCP tools send commands via WebSocket
 * and the client executes them in the Electron webview, returning results.
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  BrowserLaunchedListener,
  BrowserManagerOptions,
  BrowserStateEvent,
} from "./browser-manager.js";

type EmitFn = (message: unknown) => void;

interface PendingCommand {
  resolve: (result: { success: boolean; result?: Record<string, unknown>; error?: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class ClientBrowserManager {
  private readonly log: Logger;
  private readonly onStateChange?: (event: BrowserStateEvent) => void;
  private readonly launchListeners = new Set<BrowserLaunchedListener>();
  private emit: EmitFn | null = null;
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly activeBrowsers = new Map<string, { url: string; title: string }>();

  constructor(options: BrowserManagerOptions) {
    this.log = options.logger.child({ component: "ClientBrowserManager" });
    this.onStateChange = options.onStateChange;
  }

  /** Set the emit function for sending WebSocket messages to the client */
  setEmit(emit: EmitFn): void {
    this.emit = emit;
  }

  onBrowserLaunched(listener: BrowserLaunchedListener): () => void {
    this.launchListeners.add(listener);
    return () => {
      this.launchListeners.delete(listener);
    };
  }

  /** Handle result from client webview */
  handleCommandResult(result: {
    requestId: string;
    browserId: string;
    success: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }): void {
    const pending = this.pendingCommands.get(result.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCommands.delete(result.requestId);
      pending.resolve(result);
    }
  }

  private async sendCommand(
    browserId: string,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<{ success: boolean; result?: Record<string, unknown>; error?: string }> {
    if (!this.emit) {
      throw new Error("No client connected");
    }

    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error(`Browser command timed out: ${command}`));
      }, 30_000);

      this.pendingCommands.set(requestId, { resolve, timeout });

      this.emit!({
        type: "browser_command",
        payload: { requestId, browserId, command, args },
      });
    });
  }

  async launch(options?: {
    url?: string;
  }): Promise<{ browserId: string; url: string; title: string }> {
    const browserId = randomUUID();
    const url = options?.url || "about:blank";

    this.log.info(
      { browserId, url, hasEmit: !!this.emit, listenerCount: this.launchListeners.size },
      "ClientBrowserManager.launch called",
    );

    this.activeBrowsers.set(browserId, { url, title: "" });

    for (const listener of this.launchListeners) {
      try {
        listener({ browserId, url, title: "" });
      } catch (err) {
        this.log.warn({ err }, "browser launch listener error");
      }
    }

    return { browserId, url, title: "" };
  }

  async navigate(browserId: string, url: string): Promise<{ url: string; title: string }> {
    const result = await this.sendCommand(browserId, "navigate", { url });
    if (!result.success) throw new Error(result.error || "Navigation failed");
    const title = (result.result?.title as string) || "";
    const finalUrl = (result.result?.url as string) || url;
    this.activeBrowsers.set(browserId, { url: finalUrl, title });
    this.onStateChange?.({ browserId, url: finalUrl, title });
    return { url: finalUrl, title };
  }

  async click(browserId: string, selector: string): Promise<void> {
    const result = await this.sendCommand(browserId, "click", { selector });
    if (!result.success) throw new Error(result.error || "Click failed");
  }

  async fill(browserId: string, selector: string, value: string): Promise<void> {
    const result = await this.sendCommand(browserId, "fill", { selector, value });
    if (!result.success) throw new Error(result.error || "Fill failed");
  }

  async screenshot(browserId: string): Promise<{ data: string; mimeType: string }> {
    const result = await this.sendCommand(browserId, "screenshot", {});
    if (!result.success) throw new Error(result.error || "Screenshot failed");
    return {
      data: (result.result?.data as string) || "",
      mimeType: (result.result?.mimeType as string) || "image/png",
    };
  }

  async evaluate(browserId: string, expression: string): Promise<{ result: string }> {
    const res = await this.sendCommand(browserId, "evaluate", { expression });
    if (!res.success) throw new Error(res.error || "Evaluate failed");
    return { result: (res.result?.result as string) || "" };
  }

  async getText(browserId: string): Promise<string> {
    const res = await this.sendCommand(browserId, "get_text", {});
    if (!res.success) throw new Error(res.error || "getText failed");
    return (res.result?.text as string) || "";
  }

  async goBack(browserId: string): Promise<{ url: string; title: string }> {
    const res = await this.sendCommand(browserId, "go_back", {});
    if (!res.success) throw new Error(res.error || "goBack failed");
    return { url: (res.result?.url as string) || "", title: (res.result?.title as string) || "" };
  }

  async goForward(browserId: string): Promise<{ url: string; title: string }> {
    const res = await this.sendCommand(browserId, "go_forward", {});
    if (!res.success) throw new Error(res.error || "goForward failed");
    return { url: (res.result?.url as string) || "", title: (res.result?.title as string) || "" };
  }

  async getPageState(browserId: string): Promise<{ url: string; title: string }> {
    const cached = this.activeBrowsers.get(browserId);
    if (cached) return cached;
    return { url: "", title: "" };
  }

  async close(browserId: string): Promise<void> {
    this.activeBrowsers.delete(browserId);
  }

  async dispose(): Promise<void> {
    for (const [, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout);
    }
    this.pendingCommands.clear();
    this.activeBrowsers.clear();
  }
}
