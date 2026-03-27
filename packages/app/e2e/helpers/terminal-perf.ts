import type { Page } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

export type TerminalPerfDaemonClient = {
  connect(): Promise<void>;
  close(): Promise<void>;
  createTerminal(
    cwd: string,
    name?: string,
  ): Promise<{
    terminal: { id: string; name: string; cwd: string } | null;
    error: string | null;
  }>;
  subscribeTerminal(
    terminalId: string,
  ): Promise<{ terminalId: string; slot: number; error: null } | { error: string }>;
  sendTerminalInput(
    terminalId: string,
    message: { type: "input"; data: string } | { type: "resize"; rows: number; cols: number },
  ): void;
  onTerminalStreamEvent(
    handler: (event: { terminalId: string; type: string; data?: Uint8Array }) => void,
  ): () => void;
  killTerminal(terminalId: string): Promise<{ error: string | null }>;
};

function getDaemonWsUrl(): string {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error("E2E_DAEMON_PORT is not set.");
  }
  return `ws://127.0.0.1:${daemonPort}/ws`;
}

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

async function loadDaemonClientConstructor(): Promise<
  new (config: { url: string; clientId: string; clientType: "cli" }) => TerminalPerfDaemonClient
> {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, "packages/server/dist/server/server/exports.js"),
  ).href;
  const mod = (await import(moduleUrl)) as {
    DaemonClient: new (config: {
      url: string;
      clientId: string;
      clientType: "cli";
    }) => TerminalPerfDaemonClient;
  };
  return mod.DaemonClient;
}

export async function connectTerminalClient(): Promise<TerminalPerfDaemonClient> {
  const DaemonClient = await loadDaemonClientConstructor();
  const client = new DaemonClient({
    url: getDaemonWsUrl(),
    clientId: `terminal-perf-${randomUUID()}`,
    clientType: "cli",
  });
  await client.connect();
  return client;
}

export function buildTerminalWorkspaceUrl(cwd: string, terminalId: string): string {
  const serverId = getServerId();
  const route = buildHostWorkspaceRoute(serverId, cwd);
  return `${route}?open=${encodeURIComponent(`terminal:${terminalId}`)}`;
}

export async function getTerminalBufferText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__paseoTerminal;
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
  input: { cwd: string; terminalId: string },
): Promise<void> {
  // Boot the app at the workspace route directly.
  // The fixtures.ts beforeEach addInitScript seeds localStorage on every navigation,
  // so the daemon registry is already configured when the app starts.
  const workspaceRoute = buildHostWorkspaceRoute(getServerId(), input.cwd);
  await page.goto(workspaceRoute);

  // Wait for daemon connection (sidebar shows host label)
  await page.getByText("localhost", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });

  // The workspace should now query listTerminals and discover our terminal.
  // Click the terminal tab if it auto-appeared, or wait for it.
  const terminalSurface = page.locator('[data-testid="terminal-surface"]');
  const surfaceVisible = await terminalSurface.isVisible().catch(() => false);

  if (!surfaceVisible) {
    // Terminal tab might not be focused — look for it in the tab row and click it
    const terminalTab = page.locator(`[data-testid="workspace-tab-terminal:${input.terminalId}"]`);
    const tabExists = await terminalTab.isVisible({ timeout: 5_000 }).catch(() => false);

    if (tabExists) {
      await terminalTab.click();
    } else {
      // Terminal tab not yet created — click "New terminal tab" to create one through the UI
      const newTerminalBtn = page.getByRole("button", { name: "New terminal tab" });
      await newTerminalBtn.waitFor({ state: "visible", timeout: 10_000 });
      await newTerminalBtn.click();
    }
  }

  // Wait for terminal surface to be visible
  await terminalSurface.waitFor({ state: "visible", timeout: 15_000 });

  // Wait for loading overlay to disappear (terminal attached)
  await page
    .locator('[data-testid="terminal-attach-loading"]')
    .waitFor({ state: "hidden", timeout: 10_000 })
    .catch(() => {
      // overlay may never appear if attachment is instant
    });

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

export type LatencySample = {
  char: string;
  latencyMs: number;
};

/**
 * Measures keystroke echo round-trip latency.
 *
 * Starts a high-resolution timer on the browser keydown event (capture phase)
 * and stops it when xterm.js finishes parsing the echoed write. This measures
 * the full path: keydown → WebSocket → daemon PTY echo → WebSocket → xterm render.
 */
export async function measureKeystrokeLatency(page: Page, char: string): Promise<number> {
  await page.evaluate(() => {
    const term = (window as any).__paseoTerminal;
    if (!term) {
      throw new Error("__paseoTerminal not available");
    }

    const state = ((window as any).__perfKeystroke = {
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

  return page.evaluate(() => (window as any).__perfKeystroke.promise);
}

export function computePercentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
