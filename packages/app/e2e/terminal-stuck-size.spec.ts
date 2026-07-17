import { test, expect, type Page } from "./fixtures";
import { TerminalE2EHarness } from "./helpers/terminal-dsl";
import { buildHostWorkspaceRoute } from "../src/utils/host-routes";
import { getServerId } from "./helpers/server-id";

/**
 * Regression: a terminal created while the window is unfocused must still claim its PTY size
 * once focus returns.
 *
 * The PTY is only ever resized by an explicit client claim (`terminal_input` resize). A freshly
 * mounted terminal produces exactly one claim, from terminal-pane's pane-focus reflow effect. If
 * that claim is emitted while the app is not actively visible (window blurred / document hidden),
 * `handleTerminalResize` drops it — and nothing used to re-send it, leaving the PTY at 80x24
 * while xterm renders the real pane size: vim/top squeezed into a corner until the user resizes
 * the window.
 *
 * The repro is the mundane user flow: with a workspace already showing a terminal, open another
 * one and switch to a different app while it spawns. We stage the blur deterministically by
 * stubbing `document.hasFocus()` (which `useAppVisible` consults on window focus/blur events)
 * instead of racing real OS focus. The first terminal matters: `useAppVisible` only observes
 * focus events while a consumer is mounted, so it is what makes the blur visible to the app —
 * exactly as in the real flow.
 *
 * The assertion reads the PTY's own opinion of its size (`stty size`) with input written
 * daemon-side — clicking or typing in the pane would fire the focus-claim path and mask the bug.
 */

/**
 * Simulates the window losing/regaining OS focus, which is what `useAppVisible` reads through
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

async function readTerminalBufferText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const terminal = (
      window as Window & {
        __paseoTerminal?: {
          buffer: {
            active: {
              length: number;
              getLine(index: number): { translateToString(trim: boolean): string } | undefined;
            };
          };
        };
      }
    ).__paseoTerminal;
    if (!terminal) {
      return "";
    }
    const lines: string[] = [];
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      lines.push(terminal.buffer.active.getLine(index)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
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

function claimsFor(frames: ResizeClaim[], terminalId: string): ResizeClaim[] {
  return frames.filter((frame) => frame.terminalId === terminalId);
}

function parseSttySize(bufferText: string): RenderedTerminalSize {
  const match = /S=(\d+) (\d+)=/.exec(bufferText);
  if (!match?.[1] || !match[2]) {
    throw new Error(`stty size did not print in the terminal buffer:\n${bufferText}`);
  }
  return { rows: Number(match[1]), cols: Number(match[2]) };
}

interface ResizeClaim {
  terminalId: string;
  rows: number;
  cols: number;
}

/**
 * Records every resize claim the app puts on the wire. Claims travel two ways: as a JSON
 * `terminal_input` before the stream has a binary slot, and as a binary frame
 * ([opcode 0x03][slot][JSON {rows, cols}]) once subscribed. The slot -> terminal mapping comes
 * from subscribe_terminal_response on the receive side.
 */
function captureResizeClaims(page: Page): ResizeClaim[] {
  const resizeFrames: ResizeClaim[] = [];
  const slotTerminals = new Map<number, string>();
  const unmappedBinaryResizes: Array<{ slot: number; rows: number; cols: number }> = [];

  const recordBinaryResize = (slot: number, size: { rows: number; cols: number }) => {
    const terminalId = slotTerminals.get(slot);
    if (terminalId) {
      resizeFrames.push({ terminalId, ...size });
    } else {
      unmappedBinaryResizes.push({ slot, ...size });
    }
  };

  const handleSentFrame = (frame: { payload: string | Buffer }) => {
    const payload = frame.payload;
    if (typeof payload !== "string") {
      if (payload.length >= 2 && payload[0] === 0x03) {
        try {
          const parsed = JSON.parse(payload.subarray(2).toString("utf8")) as {
            rows?: number;
            cols?: number;
          };
          if (parsed.rows !== undefined && parsed.cols !== undefined) {
            recordBinaryResize(payload[1] ?? -1, { rows: parsed.rows, cols: parsed.cols });
          }
        } catch {
          // not a terminal resize frame — ignore
        }
      }
      return;
    }
    if (!payload.includes("resize")) {
      return;
    }
    try {
      const outer = JSON.parse(payload) as { message?: Record<string, unknown> };
      const message = outer.message ?? {};
      if (message.type !== "terminal_input") {
        return;
      }
      const inner = message.message as { type?: string; rows?: number; cols?: number };
      if (inner?.type === "resize" && inner.rows !== undefined && inner.cols !== undefined) {
        resizeFrames.push({
          terminalId: String(message.terminalId ?? ""),
          rows: inner.rows,
          cols: inner.cols,
        });
      }
    } catch {
      // not JSON — ignore
    }
  };

  const handleReceivedFrame = (frame: { payload: string | Buffer }) => {
    const payload = frame.payload;
    if (typeof payload !== "string" || !payload.includes("subscribe_terminal_response")) {
      return;
    }
    try {
      const outer = JSON.parse(payload) as { message?: Record<string, unknown> };
      const message = outer.message ?? {};
      if (message.type !== "subscribe_terminal_response") {
        return;
      }
      const responsePayload = (message.payload ?? {}) as { terminalId?: string; slot?: number };
      if (
        typeof responsePayload.terminalId === "string" &&
        typeof responsePayload.slot === "number"
      ) {
        slotTerminals.set(responsePayload.slot, responsePayload.terminalId);
        for (const entry of unmappedBinaryResizes.splice(0)) {
          recordBinaryResize(entry.slot, { rows: entry.rows, cols: entry.cols });
        }
      }
    } catch {
      // not JSON — ignore
    }
  };

  page.on("websocket", (ws) => {
    ws.on("framesent", handleSentFrame);
    ws.on("framereceived", handleReceivedFrame);
  });

  return resizeFrames;
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
    const resizeFrames = captureResizeClaims(page);

    await page.goto(buildHostWorkspaceRoute(getServerId(), harness.workspaceId));
    await expect(page.getByTestId("workspace-new-tab-menu-trigger")).toBeVisible({
      timeout: 30_000,
    });

    // A terminal is already open — this also keeps useAppVisible's listeners mounted so the
    // upcoming blur is actually observed by the app. Wait for the daemon to know about it rather
    // than sleeping: if it were missing from this snapshot it would be misread as "new" below.
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

    // Let every mount-time refit run (the ladder goes out to 2s) while the window stays blurred.
    // This one has to be a wait, not a poll: the assertion is that nothing happens.
    await page.waitForTimeout(2_500);

    // Nothing may reach the daemon while the app is hidden — handleTerminalResize drops claims
    // that fire while !isAppVisible. Without this, deleting that gate would still leave the test
    // green: the claim would simply arrive early instead of after focus returns.
    expect(claimsFor(resizeFrames, newTerminalId)).toEqual([]);

    // ...and comes back.
    await setWindowFocused(page, true);

    // __paseoTerminal points at the most recently mounted xterm — the new terminal.
    const rendered = requireTerminalSize(await readRenderedTerminalSize(page));
    // Sanity: the pane really rendered at a desktop size, not the PTY default.
    expect(rendered.cols).toBeGreaterThan(80);

    // The claim must reach the wire once focus is back. Poll for it rather than sleeping: this
    // is the behavior under test, so waiting a fixed duration would trade a real assertion for
    // a timing bet.
    const claimsForNewTerminal = () => claimsFor(resizeFrames, newTerminalId);
    await expect
      .poll(claimsForNewTerminal, { timeout: 15_000 })
      .toContainEqual({ terminalId: newTerminalId, rows: rendered.rows, cols: rendered.cols });

    // And the PTY itself must agree. Ask it via the daemon, never via the page: focusing or
    // typing in the pane triggers the focus-claim path and would mask the bug.
    await harness.client.subscribeTerminal(newTerminalId);
    harness.client.sendTerminalInput(newTerminalId, {
      type: "input",
      data: 'echo "S=$(stty size)="\n',
    });

    await expect
      .poll(async () => readTerminalBufferText(page), { timeout: 15_000 })
      .toMatch(/S=\d+ \d+=/);

    const ptySize = parseSttySize(await readTerminalBufferText(page));

    // The PTY must match what xterm rendered — not the daemon's 80x24 spawn default.
    expect(ptySize).toEqual({ rows: rendered.rows, cols: rendered.cols });
  });
});
