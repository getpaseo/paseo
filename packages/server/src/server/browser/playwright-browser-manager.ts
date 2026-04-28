/**
 * PlaywrightBrowserManager — controls the desktop app's <webview> panes
 * via Chrome DevTools Protocol using playwright-core.
 *
 * Architecture:
 *   Electron desktop launches with `--remote-debugging-port=9222`. Every
 *   webview element in the app is a separate CDP "page" target. This
 *   manager connects to that CDP endpoint once, then finds the specific
 *   page backing each `browserId` by matching a marker URL, and drives
 *   it with Playwright's battle-tested `Page` API (`page.goto`,
 *   `page.click`, `page.fill`, etc.).
 *
 *   Compared to the hand-rolled ClientBrowserManager this replaces, we
 *   no longer emit `browser_command` messages over the WS, no longer
 *   rely on `wv.loadURL` quirks, and no longer need `waitForPageIdle` /
 *   `capturePage()` retries — Playwright handles page-idle waits,
 *   navigation races, and screenshots natively.
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import type {
  BrowserLaunchedListener,
  BrowserManagerOptions,
  BrowserStateEvent,
} from "./browser-manager.js";

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

function buttonsMask(button: "left" | "right" | "middle"): number {
  return button === "left" ? 1 : button === "right" ? 2 : 4;
}

/**
 * Windows virtual key codes for non-character keys. CDP won't perform
 * the default action (delete a char on Backspace, submit on Enter,
 * move caret on arrows, etc.) unless we pass `windowsVirtualKeyCode`
 * alongside `key`/`code`. Character keys don't need this because they
 * drive input via the `text` field.
 */
const KEY_TO_VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
};

type EmitFn = (message: unknown) => void;

interface ManagedBrowser {
  browserId: string;
  /** URL the client webview was originally opened with — used as a
   * stable lookup key to find the matching Playwright page. */
  originatingUrl: string;
  page: Page | null;
}

export class PlaywrightBrowserManager {
  private readonly log: Logger;
  private readonly cdpEndpoint: string;
  private readonly onStateChange?: (event: BrowserStateEvent) => void;
  private readonly launchListeners = new Set<BrowserLaunchedListener>();
  private readonly browsers = new Map<string, ManagedBrowser>();
  private emit: EmitFn | null = null;
  private browserPromise: Promise<Browser> | null = null;
  /** Active CDP screencasts keyed by browserId. We ref-count subscribers so
   * multiple visitors on the same page share one underlying screencast and
   * the last unsubscribe tears it down. */
  private readonly screencasts = new Map<string, { cdp: CDPSession; refCount: number }>();

  constructor(options: BrowserManagerOptions & { cdpEndpoint?: string }) {
    this.log = options.logger.child({ component: "PlaywrightBrowserManager" });
    this.onStateChange = options.onStateChange;
    this.cdpEndpoint = options.cdpEndpoint ?? DEFAULT_CDP_ENDPOINT;
  }

  /** Set the emit function used to dispatch `browser_launched` events to
   * the desktop client so it creates a webview pane. */
  setEmit(emit: EmitFn): () => void {
    this.emit = emit;
    const emitSnapshot = () => {
      if (this.emit !== emit) return;
      const activeIds = Array.from(this.browsers.keys());
      this.log.info({ activeIds }, "PlaywrightBrowserManager → browser_active_list");
      try {
        emit({ type: "browser_active_list", payload: { browserIds: activeIds } });
      } catch (err) {
        this.log.warn({ err }, "failed to emit browser_active_list");
      }
    };
    // Defer both emits. setEmit is called inside the Session
    // constructor before `this.sessionLogger` is initialized; calling
    // back into Session.emit synchronously crashes with "Cannot read
    // properties of undefined (reading 'trace')". Next-tick lets the
    // constructor finish first.
    const initialTimer = setTimeout(emitSnapshot, 0);
    const replayTimer = setTimeout(emitSnapshot, 1500);
    return () => {
      clearTimeout(initialTimer);
      clearTimeout(replayTimer);
      if (this.emit === emit) this.emit = null;
    };
  }

  onBrowserLaunched(listener: BrowserLaunchedListener): () => void {
    this.launchListeners.add(listener);
    return () => {
      this.launchListeners.delete(listener);
    };
  }

  /** Lazily establish the CDP connection. Subsequent calls return the
   * same browser — it's a singleton attached to the live Electron UI. */
  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.log.info({ endpoint: this.cdpEndpoint }, "connecting to Electron CDP");
      this.browserPromise = chromium.connectOverCDP(this.cdpEndpoint).catch((err) => {
        this.browserPromise = null;
        this.log.error({ err }, "failed to connect to Electron CDP");
        throw new Error(
          `Cannot reach Electron CDP at ${this.cdpEndpoint} — is the Hubcode desktop app running?`,
        );
      });
    }
    return this.browserPromise;
  }

  /** Find the Playwright page backing a given browserId. Retries with a
   * short delay because there's a visible race the first time a browser
   * is launched: Electron creates the `<webview>` element asynchronously
   * and it may not be registered as a CDP target yet when the agent
   * fires the next tool. Without retries, that first `get_text` /
   * `screenshot` / etc. lands with no matching page and returns empty. */
  private async findPage(
    browserId: string,
    { retries = 14, delayMs = 500 }: { retries?: number; delayMs?: number } = {},
  ): Promise<Page> {
    const managed = this.browsers.get(browserId);
    if (!managed) throw new Error(`Unknown browserId: ${browserId}`);
    if (managed.page && !managed.page.isClosed()) return managed.page;

    const browser = await this.getBrowser();
    let targetHost: string | null = null;
    try {
      targetHost = new URL(managed.originatingUrl).host || null;
    } catch {
      targetHost = null;
    }

    // CRITICAL: the Electron main window (Hubcode UI) is also a CDP
    // page. If we match against it and call page.goto(), we'll blow up
    // the app's own React tree. Exclude it per-page by URL pattern —
    // the main window is always served from Metro or a `file://` bundle
    // path, never an http(s) URL the agent would navigate to.
    //
    // `about:blank` IS allowed: a freshly-mounted <webview> transits
    // through about:blank before loading its src, and skipping it makes
    // the first agent tool after launch find no candidate.
    const isHubcodeUi = (url: string) =>
      url.startsWith("http://localhost:8081") ||
      url.startsWith("http://127.0.0.1:8081") ||
      url.startsWith("http://localhost:19000") || // expo metro alt
      url.startsWith("file://") ||
      url.startsWith("chrome-extension:") ||
      url.startsWith("chrome://") ||
      url.startsWith("devtools://");

    for (let attempt = 0; attempt <= retries; attempt++) {
      const allPages: Page[] = [];
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) allPages.push(p);
      }
      const candidates = allPages.filter((p) => !isHubcodeUi(p.url()));
      const match =
        candidates.find((p) => p.url() === managed.originatingUrl) ??
        (targetHost ? candidates.find((p) => p.url().includes(targetHost)) : undefined) ??
        // Prefer a non-blank page over about:blank for the generic
        // fallback (the real target usually finishes loading soon
        // after the webview is mounted).
        candidates.find((p) => p.url() !== "about:blank") ??
        candidates[0];
      if (match) {
        managed.page = match;
        this.log.info({ browserId, matchedUrl: match.url(), attempt }, "findPage resolved");
        return match;
      }
      if (attempt < retries) {
        this.log.debug(
          {
            browserId,
            attempt,
            allPages: allPages.map((p) => p.url()).slice(0, 10),
            candidates: candidates.map((p) => p.url()).slice(0, 10),
          },
          "findPage: no match yet, retrying",
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error(
      `No Playwright page found for browserId ${browserId} (looking for ${managed.originatingUrl}). The <webview> may not have been created yet — retry the command in a moment.`,
    );
  }

  async launch(options?: {
    url?: string;
  }): Promise<{ browserId: string; url: string; title: string }> {
    const requestedUrl = options?.url;

    // Reuse existing: the UX invariant is one visible browser at a time.
    const existing = this.browsers.entries().next();
    if (!existing.done) {
      const [browserId, managed] = existing.value;
      this.log.info({ browserId, requestedUrl }, "launch reusing existing browser");
      let finalUrl = managed.originatingUrl;
      let finalTitle = "";
      if (requestedUrl && requestedUrl !== managed.originatingUrl) {
        try {
          const nav = await this.navigate(browserId, requestedUrl);
          finalUrl = nav.url;
          finalTitle = nav.title;
        } catch (err) {
          this.log.warn({ err }, "reuse-navigate failed, returning cached state");
        }
      }
      for (const l of this.launchListeners) {
        try {
          l({ browserId, url: finalUrl, title: finalTitle });
        } catch {}
      }
      return { browserId, url: finalUrl, title: finalTitle };
    }

    const browserId = randomUUID();
    // Default to Google instead of about:blank — the agent almost
    // always wants a real starting page, and opening an empty tab
    // gave users the visual of a broken / white browser.
    const url = requestedUrl || "https://www.google.com";
    this.browsers.set(browserId, { browserId, originatingUrl: url, page: null });
    this.log.info({ browserId, url }, "launch new browser");
    for (const l of this.launchListeners) {
      try {
        l({ browserId, url, title: "" });
      } catch {}
    }
    // Preheat the findPage cache in the background. The client takes a
    // beat to mount the <webview>; without preheating, the first tool
    // call pays that latency via retries. Fire-and-forget.
    void this.findPage(browserId, { retries: 20, delayMs: 300 }).catch(() => {});
    return { browserId, url, title: "" };
  }

  async navigate(browserId: string, url: string): Promise<{ url: string; title: string }> {
    this.log.info({ browserId, url }, "tool: navigate");
    const page = await this.findPage(browserId);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(300);
    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const managed = this.browsers.get(browserId);
    if (managed) managed.originatingUrl = finalUrl;
    this.onStateChange?.({ browserId, url: finalUrl, title });
    this.log.info({ browserId, finalUrl, title }, "tool: navigate done");
    return { url: finalUrl, title };
  }

  async click(browserId: string, selector: string): Promise<void> {
    this.log.info({ browserId, selector }, "tool: click");
    const page = await this.findPage(browserId);
    await page.click(selector, { timeout: 10_000 });
    // A click often triggers navigation. Wait for the page to settle
    // so subsequent get_text/screenshot see the new DOM.
    await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(200);
    this.refreshCachedUrl(browserId, page);
    this.log.info({ browserId, selector, urlAfter: page.url() }, "tool: click done");
  }

  async fill(browserId: string, selector: string, value: string): Promise<void> {
    this.log.info({ browserId, selector, valueLen: value.length }, "tool: fill");
    const page = await this.findPage(browserId);
    await page.fill(selector, value, { timeout: 10_000 });
    this.log.info({ browserId, selector }, "tool: fill done");
  }

  /** Keep `originatingUrl` in sync with the page's current URL so the
   * next findPage() fallback by-host search lands correctly even if the
   * user (or a click) navigated the webview since launch. */
  private refreshCachedUrl(browserId: string, page: Page): void {
    const managed = this.browsers.get(browserId);
    if (!managed) return;
    const url = page.url();
    if (url && url !== "about:blank") managed.originatingUrl = url;
  }

  async screenshot(browserId: string): Promise<{ data: string; mimeType: string }> {
    this.log.info({ browserId }, "tool: screenshot");
    const page = await this.findPage(browserId);
    const buf = await page.screenshot({ fullPage: false, type: "png" });
    const data = buf.toString("base64");
    this.log.info({ browserId, bytes: data.length, url: page.url() }, "tool: screenshot done");
    return { data, mimeType: "image/png" };
  }

  async evaluate(browserId: string, expression: string): Promise<{ result: string }> {
    this.log.info({ browserId, exprPreview: expression.slice(0, 120) }, "tool: evaluate");
    const page = await this.findPage(browserId);
    const res = await page.evaluate(expression);
    const result = typeof res === "string" ? res : JSON.stringify(res);
    this.log.info({ browserId, resultLen: result.length }, "tool: evaluate done");
    return { result };
  }

  async getText(browserId: string): Promise<string> {
    this.log.info({ browserId }, "tool: getText");
    const page = await this.findPage(browserId);
    const text = await page.evaluate(
      () => document.body?.innerText || document.body?.textContent || "",
    );
    const clipped = (text ?? "").slice(0, 200_000);
    this.log.info({ browserId, chars: clipped.length, url: page.url() }, "tool: getText done");
    return clipped;
  }

  async scroll(
    browserId: string,
    options: { deltaY?: number; to?: "top" | "bottom"; selector?: string },
  ): Promise<void> {
    this.log.info({ browserId, options }, "tool: scroll");
    const page = await this.findPage(browserId);
    if (options.selector) {
      await page.locator(options.selector).first().scrollIntoViewIfNeeded({ timeout: 5_000 });
      return;
    }
    if (options.to === "top") {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as any }));
      return;
    }
    if (options.to === "bottom") {
      await page.evaluate(() =>
        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: "instant" as any,
        }),
      );
      return;
    }
    const deltaY = options.deltaY ?? 500;
    await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: "instant" as any }), deltaY);
    // Give lazy-loaded content a beat to fetch/render after the scroll.
    await page.waitForTimeout(300);
  }

  async hover(browserId: string, selector: string): Promise<void> {
    this.log.info({ browserId, selector }, "tool: hover");
    const page = await this.findPage(browserId);
    await page.hover(selector, { timeout: 10_000 });
  }

  async pressKey(browserId: string, key: string): Promise<void> {
    this.log.info({ browserId, key }, "tool: pressKey");
    const page = await this.findPage(browserId);
    await page.keyboard.press(key);
    // Key presses (Enter on a form input, arrow keys, etc.) often
    // trigger navigation or content changes — settle so the next
    // tool sees the new state.
    await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(150);
  }

  async waitFor(
    browserId: string,
    options: {
      selector?: string;
      state?: "visible" | "attached" | "hidden" | "detached";
      timeoutMs?: number;
    },
  ): Promise<void> {
    this.log.info({ browserId, options }, "tool: waitFor");
    const page = await this.findPage(browserId);
    const timeout = options.timeoutMs ?? 10_000;
    if (options.selector) {
      await page.waitForSelector(options.selector, {
        state: options.state ?? "visible",
        timeout,
      });
    } else {
      await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
    }
  }

  /** Return anchor links in the page viewport with their text and
   * resolved href. Useful for "click the first search result" patterns
   * where the agent doesn't know the exact selector — it can pick the
   * link by text/href and call `browser_navigate` directly, sidestepping
   * click intercepts (overlays, SPA routers that swallow the event). */
  async getLinks(
    browserId: string,
    options: { scope?: string; limit?: number; viewportOnly?: boolean } = {},
  ): Promise<Array<{ text: string; href: string; title: string }>> {
    this.log.info({ browserId, options }, "tool: getLinks");
    const page = await this.findPage(browserId);
    const scope = options.scope ?? "body";
    const limit = options.limit ?? 60;
    const viewportOnly = options.viewportOnly ?? false;
    const links = await page.evaluate(
      ({ scope, limit, viewportOnly }) => {
        const root = document.querySelector(scope) || document.body;
        if (!root) return [];
        const out: Array<{ text: string; href: string; title: string }> = [];
        const vpW = window.innerWidth;
        const vpH = window.innerHeight;
        const anchors = root.querySelectorAll<HTMLAnchorElement>("a[href]");
        anchors.forEach((a) => {
          if (out.length >= limit) return;
          const href = a.href;
          if (!href || href.startsWith("javascript:")) return;
          if (viewportOnly) {
            const r = a.getBoundingClientRect();
            const visible = r.bottom > 0 && r.top < vpH && r.right > 0 && r.left < vpW;
            if (!visible) return;
          }
          const text = (a.innerText || a.textContent || "").trim().slice(0, 200);
          const title = a.getAttribute("title") || a.getAttribute("aria-label") || "";
          out.push({ text, href, title });
        });
        return out;
      },
      { scope, limit, viewportOnly },
    );
    return links;
  }

  async goBack(browserId: string): Promise<{ url: string; title: string }> {
    this.log.info({ browserId }, "tool: goBack");
    const page = await this.findPage(browserId);
    await page.goBack({ timeout: 10_000 }).catch(() => {});
    const url = page.url();
    const title = await page.title().catch(() => "");
    this.log.info({ browserId, url, title }, "tool: goBack done");
    return { url, title };
  }

  async goForward(browserId: string): Promise<{ url: string; title: string }> {
    this.log.info({ browserId }, "tool: goForward");
    const page = await this.findPage(browserId);
    await page.goForward({ timeout: 10_000 }).catch(() => {});
    const url = page.url();
    const title = await page.title().catch(() => "");
    this.log.info({ browserId, url, title }, "tool: goForward done");
    return { url, title };
  }

  async getPageState(browserId: string): Promise<{ url: string; title: string }> {
    try {
      const page = await this.findPage(browserId);
      return { url: page.url(), title: await page.title().catch(() => "") };
    } catch {
      return { url: "", title: "" };
    }
  }

  /**
   * Start a CDP screencast so shared-session visitors (who don't have a
   * native WebContentsView) can see the host's browser page. Frames are
   * emitted as `browser_frame` messages.
   *
   * Ref-counted: multiple subscribers share one screencast. We pass the
   * optional `url` hint from the client so a visitor Session that never
   * called `launch()` (and therefore doesn't have this browserId in its
   * `browsers` map) can still resolve the Playwright page via URL.
   */
  async startScreencast(browserId: string, options: { url?: string } = {}): Promise<void> {
    const existing = this.screencasts.get(browserId);
    if (existing) {
      existing.refCount++;
      this.log.info({ browserId, refCount: existing.refCount }, "screencast: ref++");
      return;
    }
    // Register the browserId if this session doesn't know it yet (visitor
    // path): findPage needs an entry in `browsers` to work.
    if (!this.browsers.has(browserId) && options.url) {
      this.browsers.set(browserId, {
        browserId,
        originatingUrl: options.url,
        page: null,
      });
    }
    const page = await this.findPage(browserId);
    const cdp = await page.context().newCDPSession(page);
    cdp.on("Page.screencastFrame", async (params: any) => {
      const sessionId = params?.sessionId;
      try {
        this.emit?.({
          type: "browser_frame",
          payload: {
            browserId,
            data: params.data,
            width: params.metadata?.deviceWidth,
            height: params.metadata?.deviceHeight,
            timestamp: params.metadata?.timestamp,
          },
        });
      } catch (err) {
        this.log.warn({ err, browserId }, "failed to emit browser_frame");
      }
      // Ack or CDP stops sending frames after a few.
      try {
        if (sessionId !== undefined) {
          await cdp.send("Page.screencastFrameAck" as any, { sessionId });
        }
      } catch {}
    });
    await cdp.send("Page.startScreencast" as any, {
      format: "jpeg",
      quality: 50,
      everyNthFrame: 2,
    });
    this.screencasts.set(browserId, { cdp, refCount: 1 });
    this.log.info({ browserId }, "screencast: started");
  }

  /**
   * Forward a UI input event from a remote viewer to the host's browser
   * page via CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`.
   * Reuses the CDP session already open for the screencast — visitors
   * without an active subscription fall back to creating a transient
   * session, so a stray click after unsubscribe still works.
   */
  async dispatchInput(payload: {
    browserId: string;
    kind: "mouse_move" | "mouse_down" | "mouse_up" | "mouse_wheel" | "key_down" | "key_up";
    x?: number;
    y?: number;
    button?: "left" | "right" | "middle";
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
    key?: string;
    code?: string;
    text?: string;
    modifiers?: number;
  }): Promise<void> {
    const existing = this.screencasts.get(payload.browserId);
    const cdp = existing
      ? existing.cdp
      : await (async () => {
          const page = await this.findPage(payload.browserId);
          return page.context().newCDPSession(page);
        })();
    const modifiers = payload.modifiers ?? 0;
    try {
      switch (payload.kind) {
        case "mouse_move":
          await cdp.send("Input.dispatchMouseEvent" as any, {
            type: "mouseMoved",
            x: payload.x ?? 0,
            y: payload.y ?? 0,
            modifiers,
          });
          break;
        case "mouse_down":
          await cdp.send("Input.dispatchMouseEvent" as any, {
            type: "mousePressed",
            x: payload.x ?? 0,
            y: payload.y ?? 0,
            button: payload.button ?? "left",
            buttons: buttonsMask(payload.button ?? "left"),
            clickCount: payload.clickCount ?? 1,
            modifiers,
          });
          break;
        case "mouse_up":
          await cdp.send("Input.dispatchMouseEvent" as any, {
            type: "mouseReleased",
            x: payload.x ?? 0,
            y: payload.y ?? 0,
            button: payload.button ?? "left",
            buttons: 0,
            clickCount: payload.clickCount ?? 1,
            modifiers,
          });
          break;
        case "mouse_wheel":
          await cdp.send("Input.dispatchMouseEvent" as any, {
            type: "mouseWheel",
            x: payload.x ?? 0,
            y: payload.y ?? 0,
            deltaX: payload.deltaX ?? 0,
            deltaY: payload.deltaY ?? 0,
            modifiers,
          });
          break;
        case "key_down": {
          const vk = payload.key ? KEY_TO_VK[payload.key] : undefined;
          await cdp.send("Input.dispatchKeyEvent" as any, {
            type: payload.text ? "keyDown" : "rawKeyDown",
            key: payload.key,
            code: payload.code,
            text: payload.text,
            unmodifiedText: payload.text,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
            modifiers,
          });
          break;
        }
        case "key_up": {
          const vk = payload.key ? KEY_TO_VK[payload.key] : undefined;
          await cdp.send("Input.dispatchKeyEvent" as any, {
            type: "keyUp",
            key: payload.key,
            code: payload.code,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
            modifiers,
          });
          break;
        }
      }
    } finally {
      if (!existing) {
        try {
          await cdp.detach();
        } catch {}
      }
    }
  }

  async stopScreencast(browserId: string): Promise<void> {
    const entry = this.screencasts.get(browserId);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) {
      this.log.info({ browserId, refCount: entry.refCount }, "screencast: ref--");
      return;
    }
    try {
      await entry.cdp.send("Page.stopScreencast" as any);
    } catch {}
    try {
      await entry.cdp.detach();
    } catch {}
    this.screencasts.delete(browserId);
    this.log.info({ browserId }, "screencast: stopped");
  }

  async close(browserId: string): Promise<void> {
    this.log.info({ browserId }, "tool: close");
    const sc = this.screencasts.get(browserId);
    if (sc) {
      try {
        await sc.cdp.send("Page.stopScreencast" as any);
      } catch {}
      try {
        await sc.cdp.detach();
      } catch {}
      this.screencasts.delete(browserId);
    }
    this.browsers.delete(browserId);
    // Tell the client to tear down the matching UI tab +
    // WebContentsView. Without this the pane stays visible on screen
    // even though we've forgotten about it on the server side, and
    // the user has to close it manually.
    try {
      this.emit?.({
        type: "browser_closed",
        payload: { browserId },
      });
    } catch (err) {
      this.log.warn({ err, browserId }, "failed to emit browser_closed");
    }
  }

  /**
   * Legacy entry point kept so Session's `browser_command_result` handler
   * still type-checks. With Playwright driving the page via CDP there are
   * no round-trip commands from the client to resolve — this is a no-op.
   */
  handleCommandResult(_result: {
    requestId: string;
    browserId: string;
    success: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }): void {
    void _result;
  }

  async dispose(): Promise<void> {
    this.browsers.clear();
    try {
      const browser = await this.browserPromise;
      // Don't actually close — Electron owns the Chromium process. Just
      // disconnect so our CDP session is clean.
      await browser?.close().catch(() => {});
    } catch {}
    this.browserPromise = null;
  }
}
