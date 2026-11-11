import { expect, type Page } from "@playwright/test";
import type { Terminal } from "@xterm/xterm";
import { buildHostWorkspaceRoute } from "../../../src/utils/host-routes";
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

  // The route seeds the legacy URL target into the pending-open model, then
  // removes the query. Tab readiness below waits for that intent to be consumed.
  // On CI, Expo Router's rootNavigationState may take time to initialize,
  // so we allow a generous timeout here.
  const cleanWorkspaceRoute = buildWorkspaceUrl(input.workspaceId);
  await page.waitForURL(
    (url) => url.pathname === cleanWorkspaceRoute && !url.searchParams.has("open"),
    { timeout: 30_000 },
  );

  // The open intent should have prepared and focused the exact pre-created terminal tab.
  // Its presence is the user-visible proof that workspace and terminal state have hydrated.
  // The tab reconciliation effect also auto-creates terminal tabs once hydration completes,
  // so we give it enough time for the full workspace hydration + tab creation cycle.
  const terminalTab = page.locator(`[data-testid="workspace-tab-terminal_${input.terminalId}"]`);
  await terminalTab.waitFor({ state: "visible", timeout: 30_000 });
  await terminalTab.click();

  // Inactive terminal tabs retain their surfaces; interact with the selected tab.
  const terminalSurface = page.getByTestId("terminal-surface").filter({ visible: true });
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

/** Observe actual cursor pixels and blink phases through xterm's public render event. */
export async function expectTerminalCursor(
  page: Page,
  expected: { shape: "bar" | "underline"; blinking: boolean },
): Promise<void> {
  const observed = await page.evaluate(async () => {
    const terminal = (window as Window & { __paseoTerminal?: Terminal }).__paseoTerminal;
    if (!terminal) throw new Error("Terminal did not mount");
    const source = Array.from(document.querySelectorAll(".xterm-screen canvas")).find(
      (canvas): canvas is HTMLCanvasElement =>
        canvas instanceof HTMLCanvasElement && canvas.getContext("webgl2") !== null,
    );
    if (!source) throw new Error("Cursor verification requires the actual WebGL renderer");
    const copy = document.createElement("canvas");
    const context = copy.getContext("2d");
    if (!context) throw new Error("Cursor pixel capture is unavailable");
    terminal.focus();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (!terminal.element?.contains(document.activeElement))
      throw new Error("Terminal did not focus");
    const started = performance.now();
    const frames: Array<{ time: number; width: number; height: number }> = [];
    const rendered = terminal.onRender(() => {
      copy.width = source.width;
      copy.height = source.height;
      // WebGL's default drawing buffer must be copied before this render returns.
      context.drawImage(source, 0, 0);
      const cellWidth = source.width / terminal.cols;
      const cellHeight = source.height / terminal.rows;
      const x = Math.round(terminal.buffer.active.cursorX * cellWidth);
      const y = Math.round(terminal.buffer.active.cursorY * cellHeight);
      const width = Math.ceil(cellWidth);
      const height = Math.ceil(cellHeight);
      const background = context.getImageData(x + width + 2, y, 1, 1).data;
      const pixels = context.getImageData(x, y, width, height).data;
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const offset = (row * width + col) * 4;
          if (
            ![0, 1, 2, 3].some(
              (channel) => Math.abs(pixels[offset + channel]! - background[channel]!) > 20,
            )
          )
            continue;
          minX = Math.min(minX, col);
          maxX = Math.max(maxX, col);
          minY = Math.min(minY, row);
          maxY = Math.max(maxY, row);
        }
      }
      frames.push({
        time: performance.now() - started,
        width: maxX < 0 ? 0 : (maxX - minX + 1) / cellWidth,
        height: maxY < 0 ? 0 : (maxY - minY + 1) / cellHeight,
      });
    });
    try {
      const refresh = setInterval(() => terminal.refresh(0, terminal.rows - 1), 40);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1800));
      } finally {
        clearInterval(refresh);
      }
    } finally {
      rendered.dispose();
    }
    return {
      frames,
      focused: terminal.element?.contains(document.activeElement),
      samples: frames.length,
      width: Math.max(...frames.map((frame) => frame.width)),
      height: Math.max(...frames.map((frame) => frame.height)),
      blinking:
        frames.filter(
          (frame, index) => index > 0 && (frame.width === 0) !== (frames[index - 1]!.width === 0),
        ).length >= 2,
    };
  });
  expect(observed.samples).toBeGreaterThan(5);
  expect(observed.blinking, JSON.stringify(observed)).toBe(expected.blinking);
  if (expected.shape === "bar") {
    expect(observed.width).toBeGreaterThan(0);
    expect(observed.width).toBeLessThan(0.4);
    expect(observed.height).toBeGreaterThan(0.6);
  } else {
    expect(observed.width).toBeGreaterThan(0.6);
    expect(observed.height).toBeGreaterThan(0);
    expect(observed.height).toBeLessThan(0.4);
  }
}
