import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Emitted whenever the active page URL or title changes. */
export type BrowserStateEvent = {
  browserId: string;
  url: string;
  title: string;
};

export interface BrowserManagerOptions {
  logger: Logger;
  /** Called whenever a managed page navigates or its title changes. */
  onStateChange?: (event: BrowserStateEvent) => void;
}

export type BrowserLaunchedListener = (event: {
  browserId: string;
  url: string;
  title: string;
}) => void;

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

interface ManagedBrowser {
  browserId: string;
  context: BrowserContext;
  page: Page;
}

// ---------------------------------------------------------------------------
// BrowserManager
// ---------------------------------------------------------------------------

/**
 * Manages headless Chromium browser contexts on behalf of AI agents.
 *
 * A single shared Chromium process is launched lazily on the first `launch()`
 * call. Each `launch()` creates an isolated `BrowserContext` (separate cookies,
 * storage, etc.) identified by a unique `browserId`.
 */
export class BrowserManager {
  private readonly log: Logger;
  private readonly onStateChange?: (event: BrowserStateEvent) => void;

  /** Shared Chromium instance — created lazily. */
  private browser: Browser | null = null;

  /** Active browser contexts keyed by `browserId`. */
  private readonly contexts = new Map<string, ManagedBrowser>();

  /** Listeners notified when a new browser context is launched. */
  private readonly launchListeners = new Set<BrowserLaunchedListener>();

  constructor(options: BrowserManagerOptions) {
    this.log = options.logger.child({ component: "BrowserManager" });
    this.onStateChange = options.onStateChange;
  }

  /** Register a listener that fires whenever a browser context is launched. */
  onBrowserLaunched(listener: BrowserLaunchedListener): () => void {
    this.launchListeners.add(listener);
    return () => {
      this.launchListeners.delete(listener);
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Launch a new isolated browser context.
   *
   * The underlying Chromium process is started lazily on the first call.
   */
  async launch(options?: {
    url?: string;
  }): Promise<{ browserId: string; url: string; title: string }> {
    const browser = await this.ensureBrowser();
    const browserId = randomUUID();

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Emit state-change events on navigation.
    page.on("load", () => this.emitStateChange(browserId, page));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.emitStateChange(browserId, page);
      }
    });

    this.contexts.set(browserId, { browserId, context, page });

    // Optionally navigate after launch.
    if (options?.url) {
      await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }

    const url = page.url();
    const title = await page.title();

    this.log.info({ browserId, url }, "browser context launched");

    // Notify listeners
    for (const listener of this.launchListeners) {
      try {
        listener({ browserId, url, title });
      } catch (err) {
        this.log.warn({ err }, "browser launch listener error");
      }
    }

    return { browserId, url, title };
  }

  /**
   * Navigate the page to the given URL.
   *
   * Waits until the network is mostly idle before resolving.
   */
  async navigate(browserId: string, url: string): Promise<{ url: string; title: string }> {
    const { page } = this.getContext(browserId);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const currentUrl = page.url();
    const title = await page.title();

    this.log.debug({ browserId, url: currentUrl, title }, "navigated");
    return { url: currentUrl, title };
  }

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------

  /** Click an element matching the given CSS selector. */
  async click(browserId: string, selector: string): Promise<{ success: boolean }> {
    const { page } = this.getContext(browserId);

    try {
      await page.click(selector, { timeout: 10_000 });
      this.log.debug({ browserId, selector }, "clicked");
      return { success: true };
    } catch (error) {
      this.log.warn({ browserId, selector, error }, "click failed");
      return { success: false };
    }
  }

  /** Fill an input element matching the given CSS selector. */
  async fill(browserId: string, selector: string, value: string): Promise<{ success: boolean }> {
    const { page } = this.getContext(browserId);

    try {
      await page.fill(selector, value, { timeout: 10_000 });
      this.log.debug({ browserId, selector }, "filled");
      return { success: true };
    } catch (error) {
      this.log.warn({ browserId, selector, error }, "fill failed");
      return { success: false };
    }
  }

  /** Evaluate a JavaScript expression in the page context. */
  async evaluate(browserId: string, expression: string): Promise<{ result: string }> {
    const { page } = this.getContext(browserId);

    const raw = await page.evaluate(expression);
    const result = typeof raw === "string" ? raw : JSON.stringify(raw);

    this.log.debug({ browserId }, "evaluated expression");
    return { result };
  }

  // -----------------------------------------------------------------------
  // Observation
  // -----------------------------------------------------------------------

  /** Capture a JPEG screenshot of the current page (base64-encoded). */
  async screenshot(browserId: string): Promise<{ data: string; mimeType: string }> {
    const { page } = this.getContext(browserId);

    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 80,
      fullPage: false,
    });

    return {
      data: buffer.toString("base64"),
      mimeType: "image/jpeg",
    };
  }

  /** Extract visible text content from the current page. */
  async getText(browserId: string): Promise<string> {
    const { page } = this.getContext(browserId);
    const text = await page.evaluate(() => document.body.innerText);
    return typeof text === "string" ? text : "";
  }

  /** Return the current page URL and title. */
  async getPageState(browserId: string): Promise<{ url: string; title: string }> {
    const { page } = this.getContext(browserId);

    return {
      url: page.url(),
      title: await page.title(),
    };
  }

  // -----------------------------------------------------------------------
  // Navigation helpers
  // -----------------------------------------------------------------------

  /** Resize the browser viewport. */
  async resize(browserId: string, width: number, height: number): Promise<void> {
    const { page } = this.getContext(browserId);
    await page.setViewportSize({ width, height });
    this.log.debug({ browserId, width, height }, "viewport resized");
  }

  /** Navigate one step back in history. */
  async goBack(browserId: string): Promise<{ url: string; title: string }> {
    const { page } = this.getContext(browserId);

    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });

    return {
      url: page.url(),
      title: await page.title(),
    };
  }

  /** Navigate one step forward in history. */
  async goForward(browserId: string): Promise<{ url: string; title: string }> {
    const { page } = this.getContext(browserId);

    await page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 });

    return {
      url: page.url(),
      title: await page.title(),
    };
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Close and remove a single browser context. */
  async close(browserId: string): Promise<void> {
    const managed = this.contexts.get(browserId);
    if (!managed) {
      this.log.warn({ browserId }, "close called for unknown browser id");
      return;
    }

    this.contexts.delete(browserId);

    try {
      await managed.context.close();
    } catch (error) {
      this.log.warn({ browserId, error }, "error closing browser context");
    }

    this.log.info({ browserId }, "browser context closed");
  }

  /**
   * Dispose of all managed contexts and the shared Chromium process.
   *
   * Safe to call multiple times.
   */
  async dispose(): Promise<void> {
    const ids = Array.from(this.contexts.keys());

    for (const id of ids) {
      await this.close(id);
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        this.log.warn({ error }, "error closing shared browser process");
      }
      this.browser = null;
    }

    this.log.info("browser manager disposed");
  }

  /** Return the IDs of all currently active browser contexts. */
  getActiveBrowserIds(): string[] {
    return Array.from(this.contexts.keys());
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Lazily launch the shared Chromium process.
   *
   * If the browser has already been launched, the existing instance is
   * returned. If a previous instance disconnected (crash), a fresh one is
   * started.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }

    this.log.info("launching shared chromium process");

    const launchArgs = {
      headless: true,
      args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
    };

    // Try system browsers in order: Chrome → Edge → Playwright bundled
    const channels = ["chrome", "msedge", undefined] as const;
    let lastError: unknown;

    for (const channel of channels) {
      try {
        this.browser = await chromium.launch({
          ...launchArgs,
          ...(channel ? { channel } : {}),
        });
        this.log.info({ channel: channel ?? "playwright-bundled" }, "browser launched");
        break;
      } catch (err) {
        lastError = err;
        this.log.debug(
          { channel: channel ?? "playwright-bundled", err },
          "browser launch attempt failed",
        );
      }
    }

    if (!this.browser) {
      this.log.error(
        { cause: lastError },
        "No supported browser found. Install Google Chrome or Microsoft Edge.",
      );
      throw new Error(
        "No supported browser found. Please install Google Chrome or Microsoft Edge to use browser features.",
      );
    }

    // If the process exits unexpectedly, clean up all contexts.
    this.browser.on("disconnected", () => {
      this.log.warn("chromium process disconnected — cleaning up contexts");
      for (const id of Array.from(this.contexts.keys())) {
        this.contexts.delete(id);
      }
      this.browser = null;
    });

    return this.browser;
  }

  /**
   * Retrieve a managed browser context or throw if it does not exist.
   */
  private getContext(browserId: string): ManagedBrowser {
    const managed = this.contexts.get(browserId);
    if (!managed) {
      throw new Error(`No browser context found for id: ${browserId}`);
    }
    return managed;
  }

  /**
   * Fire the `onStateChange` callback with the current page state.
   */
  private emitStateChange(browserId: string, page: Page): void {
    if (!this.onStateChange) return;

    page
      .title()
      .then((title) => {
        this.onStateChange!({
          browserId,
          url: page.url(),
          title,
        });
      })
      .catch((error) => {
        this.log.debug({ browserId, error }, "failed to read page title for state change event");
      });
  }
}
