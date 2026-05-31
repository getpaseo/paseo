import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { TerminalE2EHarness, withTerminalInApp } from "./helpers/terminal-dsl";
import { getTerminalBufferText, waitForTerminalContent } from "./helpers/terminal-perf";

interface TerminalSize {
  rows: number | null;
  cols: number | null;
}

// The xterm/client view resizes immediately on split, so it is not enough to
// prove the bug. It is the misleading symptom.
async function readXtermSize(page: Page): Promise<TerminalSize> {
  return page.evaluate(() => {
    const term = (window as Window & { __paseoTerminal?: { rows?: number; cols?: number } })
      .__paseoTerminal;
    return {
      rows: typeof term?.rows === "number" ? term.rows : null,
      cols: typeof term?.cols === "number" ? term.cols : null,
    };
  });
}

// The PTY's own view of its size, reported by an `stty size` loop running in the
// shell. This needs no focus or click, so it observes whether the daemon-side PTY
// actually received the resize frame after the split.
async function readLatestPtySize(page: Page): Promise<TerminalSize | null> {
  const text = await getTerminalBufferText(page);
  const matches = [...text.matchAll(/PTYSIZE (\d+) (\d+)/g)];
  const last = matches.at(-1);
  if (!last) {
    return null;
  }
  return { rows: Number(last[1]), cols: Number(last[2]) };
}

function hasPtySizeReport(text: string): boolean {
  return /PTYSIZE \d+ \d+/.test(text);
}

async function readXtermRows(page: Page): Promise<number | null> {
  return (await readXtermSize(page)).rows;
}

async function ptyRowsMatchXtermRows(page: Page): Promise<boolean> {
  const xterm = await readXtermSize(page);
  const pty = await readLatestPtySize(page);
  return pty?.rows === xterm.rows;
}

async function verifySplitDownResizesPty(page: Page, harness: TerminalE2EHarness): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });

  await withTerminalInApp(page, harness, { name: "split-resize" }, async () => {
    await harness.setupPrompt(page);

    const terminal = harness.terminalSurface(page);
    // Continuously echo the PTY's own size. `stty size` prints "rows cols" and
    // reads the controlling tty, so this keeps reporting the real PTY size
    // without the test ever clicking the terminal back into focus.
    await terminal.pressSequentially(
      'while true; do echo "PTYSIZE $(stty size)"; sleep 0.3; done\n',
      { delay: 0 },
    );
    await waitForTerminalContent(page, hasPtySizeReport, 10_000);

    const beforeXterm = await readXtermSize(page);
    const beforePty = await readLatestPtySize(page);
    expect(beforePty, "the PTY should report its size before splitting").not.toBeNull();
    expect(beforeXterm.rows, "xterm should report its row count before splitting").not.toBeNull();
    expect(beforePty?.rows, "while focused, the PTY size should already match the xterm size").toBe(
      beforeXterm.rows,
    );

    // Split the pane downward. This focuses the new empty pane, so the terminal
    // pane is unfocused at the exact moment its container shrinks.
    await page.getByRole("button", { name: "Split pane down" }).first().click();

    // The local xterm renderer shrinks immediately on split - the part of the
    // behaviour that already works and that makes the bug look like nothing changed.
    await expect
      .poll(() => readXtermRows(page), {
        message: "xterm should shrink after splitting the pane down",
        timeout: 8_000,
      })
      .toBeLessThan(beforeXterm.rows ?? Number.POSITIVE_INFINITY);

    // The PTY must follow the shrunken terminal, even though focus moved to the
    // new pane. Today it stays stuck at the pre-split size until the terminal is
    // clicked back into focus. This poll fails without the fix.
    await expect
      .poll(() => ptyRowsMatchXtermRows(page), {
        message: "the PTY rows should match the resized terminal after split-down",
        timeout: 8_000,
      })
      .toBe(true);
  });
}

test.describe("Terminal split resize", () => {
  test.describe.configure({ timeout: 120_000 });

  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-split-resize-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("splitting the pane down resizes the PTY even though focus moves to the new pane", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await verifySplitDownResizesPty(page, harness);
  });
});
