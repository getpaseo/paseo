import { test, expect, type Page } from "./fixtures";
import { TerminalE2EHarness } from "./helpers/terminal-dsl";
import { getTerminalBufferText } from "./helpers/terminal-perf";
import { buildHostWorkspaceRoute } from "../src/utils/host-routes";
import { getServerId } from "./helpers/server-id";

/**
 * Regression: a terminal created while the window is unfocused must still claim its PTY size
 * once focus returns.
 *
 * The PTY is only ever resized by an explicit client claim (`terminal_input` resize). A freshly
 * mounted terminal starts its claim from terminal-pane's pane-focus reflow effect. Previously, if
 * that claim was emitted while the app was not actively visible, `handleTerminalResize` dropped
 * it without a retry, leaving the PTY at 80x24 while xterm rendered the real pane size.
 *
 * The repro is the mundane user flow: with a workspace already showing a terminal, open another
 * one and switch to a different app while it spawns. We stage the blur deterministically by
 * stubbing `document.hasFocus()` (which `useAppActivelyVisible` consults on focus/blur events)
 * instead of racing real OS focus.
 *
 * The assertion reads the PTY's own opinion of its size (`stty size`) with input written
 * daemon-side — clicking or typing in the pane would fire the focus-claim path and mask the bug.
 */

/**
 * Simulates the window losing/regaining OS focus, which is what `useAppActivelyVisible` reads through
 * `document.hasFocus()` plus the window focus/blur events.
 *
 * This has to be stubbed: headless Chromium never actually blurs. Opening a second page and
 * calling bringToFront() leaves the first page at `hasFocus() === true`, `visibilityState
 * === "visible"`, and fires no focus/blur events at all — so there is no way to produce a real
 * blur from Playwright. This stubs the environment signal, not the app: the daemon, the
 * WebSocket, the terminal, and every code path under test stay real.
 */
async function setWindowFocused(page: Page, focused: boolean): Promise<void> {
  await page.evaluate((isFocused) => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => isFocused,
    });
    window.dispatchEvent(new Event(isFocused ? "focus" : "blur"));
  }, focused);
}

interface RenderedTerminalSize {
  rows: number;
  cols: number;
}

async function readRenderedTerminalSize(page: Page): Promise<RenderedTerminalSize | null> {
  return await page.evaluate(() => {
    const terminal = (window as Window & { __paseoTerminal?: { rows: number; cols: number } })
      .__paseoTerminal;
    return terminal ? { rows: terminal.rows, cols: terminal.cols } : null;
  });
}

async function createTerminalViaMenu(page: Page): Promise<void> {
  await page.getByTestId("workspace-new-tab-menu-trigger").click();
  await page.getByTestId("workspace-new-tab-menu-terminal").click();
}

async function listTerminalIds(harness: TerminalE2EHarness): Promise<string[]> {
  const listed = await harness.client.listTerminals(harness.tempRepo.path, undefined, {
    workspaceId: harness.workspaceId,
  });
  return listed.terminals.map((terminal) => terminal.id);
}

// These narrow instead of asserting: an `expect(...).toBeTruthy()` plus an early return would let
// the test pass without ever reaching the assertions that prove the fix.
function exactlyOne<T>(values: T[], what: string): T {
  const [value] = values;
  if (values.length !== 1 || value === undefined) {
    throw new Error(`Expected exactly one ${what}, got ${values.length}`);
  }
  return value;
}

function requireTerminalSize(size: RenderedTerminalSize | null): RenderedTerminalSize {
  if (!size) {
    throw new Error("No xterm instance rendered on the page");
  }
  return size;
}

function parseLatestSttySize(bufferText: string): RenderedTerminalSize | null {
  const matches = [...bufferText.matchAll(/S\d+=(\d+) (\d+)=/g)];
  const match = matches.at(-1);
  return match?.[1] && match[2] ? { rows: Number(match[1]), cols: Number(match[2]) } : null;
}

test.describe("terminal PTY size claim under lost window focus", () => {
  let harness: TerminalE2EHarness;

  test.beforeEach(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-stuck-size" });
  });

  test.afterEach(async () => {
    await harness.cleanup();
  });

  test("a terminal created while the window is blurred claims its size when focus returns", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(buildHostWorkspaceRoute(getServerId(), harness.workspaceId));
    await expect(page.getByTestId("workspace-new-tab-menu-trigger")).toBeVisible({
      timeout: 30_000,
    });

    // Wait for the daemon to know about the first terminal rather than sleeping: if it were
    // missing from this snapshot it would be misread as "new" below.
    await createTerminalViaMenu(page);
    await expect(harness.terminalSurface(page).first()).toBeVisible({ timeout: 30_000 });
    const countTerminals = async () => (await listTerminalIds(harness)).length;
    await expect.poll(countTerminals, { timeout: 15_000 }).toBe(1);
    const knownIds = new Set(await listTerminalIds(harness));

    // The user clicks away...
    await setWindowFocused(page, false);

    // ...opens another terminal while the window is unfocused...
    await createTerminalViaMenu(page);
    const findNewTerminalIds = async () =>
      (await listTerminalIds(harness)).filter((id) => !knownIds.has(id));
    await expect.poll(async () => (await findNewTerminalIds()).length, { timeout: 15_000 }).toBe(1);
    const newTerminalId = exactlyOne(await findNewTerminalIds(), "new terminal");

    // Keep the app blurred through the complete mount-time refit ladder, which runs out to 2s.
    await page.waitForTimeout(2_500);

    await harness.client.subscribeTerminal(newTerminalId);

    // Confirm the PTY is still at its spawn size before focus returns.
    harness.client.sendTerminalInput(newTerminalId, {
      type: "input",
      data: 'echo "S0=$(stty size)="\n',
    });
    await expect
      .poll(async () => getTerminalBufferText(page), { timeout: 15_000 })
      .toMatch(/S0=24 80=/);

    // ...and comes back.
    await setWindowFocused(page, true);

    // __paseoTerminal points at the most recently mounted xterm — the new terminal.
    const rendered = requireTerminalSize(await readRenderedTerminalSize(page));
    // Sanity: the pane really rendered at a desktop size, not the PTY default.
    expect(rendered.cols).toBeGreaterThan(80);

    // The PTY itself must agree. Ask it via the daemon, never via the page: focusing or
    // typing in the pane triggers the focus-claim path and would mask the bug.
    let probe = 1;
    await expect
      .poll(
        async () => {
          harness.client.sendTerminalInput(newTerminalId, {
            type: "input",
            data: `echo "S${probe++}=$(stty size)="\n`,
          });
          return parseLatestSttySize(await getTerminalBufferText(page));
        },
        { timeout: 15_000, intervals: [100, 250, 500] },
      )
      .toEqual({ rows: rendered.rows, cols: rendered.cols });
  });
});
