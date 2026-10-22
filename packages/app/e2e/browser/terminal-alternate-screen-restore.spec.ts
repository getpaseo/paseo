import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { waitForTerminalContent } from "../support/helpers/terminal-perf";

function readTerminalBufferType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const terminal = (
      window as Window & {
        __paseoTerminal?: { buffer: { active: { type: string } } };
      }
    ).__paseoTerminal;
    return terminal?.buffer.active.type ?? "";
  });
}

/**
 * Regression: the alternate screen must survive a terminal restore.
 *
 * A restore repaints the snapshot after sending RIS (`\x1bc`), which clears the
 * alternate screen as well as the DEC modes. A TUI has no reason to enter the
 * alternate screen again, so without recording the buffer the snapshot is painted
 * into the normal buffer and the app's later frames land in scrollback.
 */
test.describe("terminal alternate screen across a restore", () => {
  let harness: TerminalE2EHarness;

  test.beforeEach(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-altscreen-restore" });
  });

  test.afterEach(async () => {
    await harness.cleanup();
  });

  test("the client stays on the alternate screen after re-attaching", async ({ page }) => {
    const instance = await harness.createTerminal({ name: "altscreen" });
    try {
      await harness.openTerminal(page, { terminalId: instance.id });
      await harness.setupPrompt(page);

      // Enter the alternate screen from a normal shell, then keep the foreground
      // process alive so the re-attach sees a live TUI rather than a fresh terminal.
      await harness
        .terminalSurface(page)
        .first()
        .pressSequentially("printf '\\033[?1049hALT_READY\\n'; sleep 300\n", { delay: 0 });
      await waitForTerminalContent(page, (text) => text.includes("ALT_READY"), 20_000);
      await expect.poll(() => readTerminalBufferType(page), { timeout: 10_000 }).toBe("alternate");

      await harness.openTerminal(page, { terminalId: instance.id });
      await waitForTerminalContent(page, (text) => text.includes("ALT_READY"), 20_000);

      await expect.poll(() => readTerminalBufferType(page), { timeout: 10_000 }).toBe("alternate");
    } finally {
      await harness.killTerminal(instance.id);
    }
  });
});
