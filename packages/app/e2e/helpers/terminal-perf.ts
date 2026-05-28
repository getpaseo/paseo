import { expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { getServerId } from "./server-id";

export function buildTerminalWorkspaceUrl(workspaceId: string, terminalId: string): string {
  const serverId = getServerId();
  const route = buildHostWorkspaceRoute(serverId, workspaceId);
  return `${route}?open=${encodeURIComponent(`terminal:${terminalId}`)}`;
}

function buildWorkspaceUrl(workspaceId: string): string {
  return buildHostWorkspaceRoute(getServerId(), workspaceId);
}

export async function getTerminalBufferText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (
      window as Window & {
        __paseoTerminal?: {
          buffer: {
            active: {
              length: number;
              getLine: (i: number) => { translateToString: (trim: boolean) => string } | null;
            };
          };
          onWriteParsed: (cb: () => void) => { dispose: () => void };
        };
      }
    ).__paseoTerminal;
    if (!term) {
      return "";
    }
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    return lines.join("\n");
  });
}

export async function waitForTerminalContent(
  page: Page,
  predicate: (text: string) => boolean,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await getTerminalBufferText(page);
    if (predicate(text)) {
      return;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`Terminal content did not match predicate within ${timeout}ms`);
}

export async function navigateToTerminal(
  page: Page,
  input: { workspaceId: string; terminalId: string },
): Promise<void> {
  // Boot the app at the workspace route directly.
  // The fixtures.ts beforeEach addInitScript seeds localStorage on every navigation,
  // so the daemon registry is already configured when the app starts.
  const workspaceRoute = buildTerminalWorkspaceUrl(input.workspaceId, input.terminalId);
  await page.goto(workspaceRoute);

  // The workspace layout consumes `?open=...`, returns null during the effect,
  // then replaces the URL with the clean workspace route after preparing the tab.
  // On CI, Expo Router's rootNavigationState may take time to initialize,
  // so we allow a generous timeout here.
  const cleanWorkspaceRoute = buildWorkspaceUrl(input.workspaceId);
  await page.waitForURL(
    (url) => url.pathname === cleanWorkspaceRoute && !url.searchParams.has("open"),
    { timeout: 30_000 },
  );

  // Wait for daemon connection (sidebar shows host label)
  await page
    .getByText("localhost", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  // The open intent should have prepared and focused the exact pre-created terminal tab.
  // The tab reconciliation effect also auto-creates terminal tabs once hydration completes,
  // so we give it enough time for the full workspace hydration + tab creation cycle.
  const terminalTab = page.locator(`[data-testid="workspace-tab-terminal_${input.terminalId}"]`);
  await terminalTab.waitFor({ state: "visible", timeout: 30_000 });
  await terminalTab.click();

  const terminalSurface = page.locator('[data-testid="terminal-surface"]');
  await terminalSurface.waitFor({ state: "visible", timeout: 15_000 });

  // Wait for loading overlay to disappear (terminal attached)
  await page
    .locator('[data-testid="terminal-attach-loading"]')
    .waitFor({ state: "hidden", timeout: 10_000 })
    .catch(() => {
      // overlay may never appear if attachment is instant
    });

  await terminalSurface.scrollIntoViewIfNeeded();
  await terminalSurface.click();
}

export async function setupDeterministicPrompt(page: Page, sentinel?: string): Promise<void> {
  const tag = sentinel ?? `READY_${Date.now()}`;
  const terminal = page.locator('[data-testid="terminal-surface"]');

  await terminal.pressSequentially(`echo ${tag}\n`, { delay: 0 });
  await waitForTerminalContent(page, (text) => text.includes(tag), 10_000);

  await terminal.pressSequentially("export PS1='$ '\n", { delay: 0 });
  await page.waitForTimeout(300);
}

export interface LatencySample {
  char: string;
  latencyMs: number;
}

/**
 * Measures keystroke echo round-trip latency.
 *
 * Starts a high-resolution timer on the browser keydown event (capture phase)
 * and stops it when xterm.js finishes parsing the echoed write. This measures
 * the full path: keydown → WebSocket → daemon PTY echo → WebSocket → xterm render.
 */
export async function measureKeystrokeLatency(page: Page, char: string): Promise<number> {
  await page.evaluate(() => {
    const win = window as Window & {
      __paseoTerminal?: { onWriteParsed: (cb: () => void) => { dispose: () => void } };
      __perfKeystroke?: { promise: Promise<number> | null };
    };
    if (!win.__paseoTerminal) {
      throw new Error("__paseoTerminal not available");
    }
    const term = win.__paseoTerminal;

    const state = (win.__perfKeystroke = {
      promise: null as Promise<number> | null,
    });

    state.promise = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        document.removeEventListener("keydown", onKeyDown, true);
        reject(new Error("keystroke echo timeout (5s)"));
      }, 5000);

      function onKeyDown() {
        document.removeEventListener("keydown", onKeyDown, true);
        const start = performance.now();
        const disposable = term.onWriteParsed(() => {
          clearTimeout(timeout);
          disposable.dispose();
          resolve(performance.now() - start);
        });
      }

      document.addEventListener("keydown", onKeyDown, true);
    });
  });

  await page.keyboard.press(char);

  return page.evaluate(
    () =>
      (window as unknown as { __perfKeystroke: { promise: Promise<number> } }).__perfKeystroke
        .promise,
  );
}

export async function expectTerminalSurfaceVisible(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await expect(page.locator('[data-testid="terminal-surface"]').first()).toBeVisible({
    timeout: options?.timeout ?? 20_000,
  });
}

export async function focusTerminalSurface(page: Page): Promise<void> {
  await expectTerminalSurfaceVisible(page);
  await page.locator('[data-testid="terminal-surface"]').first().click();
}

export async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page
    .locator('[data-testid="terminal-surface"]')
    .first()
    .pressSequentially(text, { delay: 0 });
}

export async function waitForTerminalAttached(page: Page): Promise<void> {
  await page
    .locator('[data-testid="terminal-attach-loading"]')
    .waitFor({ state: "hidden", timeout: 10_000 })
    .catch(() => undefined);
}

export function computePercentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
