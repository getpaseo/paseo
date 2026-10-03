import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { withMouseTerminal } from "../support/helpers/terminal-mouse";

/**
 * Regression: mouse tracking must survive the terminal restore that happens when
 * the client re-attaches.
 *
 * A restore repaints the snapshot after sending RIS (`\x1bc`), which clears every
 * DEC private mode, then replays a small "input mode" preamble. The preamble used
 * to omit mouse tracking, so a TUI that relies on mouse reporting (Claude Code)
 * lost wheel scrolling after a restore until it re-asserted the mode itself.
 */
test.describe("terminal mouse tracking across a restore", () => {
  let harness: TerminalE2EHarness;

  test.beforeEach(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-mouse-restore" });
  });

  test.afterEach(async () => {
    await harness.cleanup();
  });

  test("the wheel keeps reporting after the terminal re-attaches", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    await withMouseTerminal(page, harness, async (terminal) => {
      await terminal.enableMouse();
      expect(await terminal.wheelReportsToApp()).toBe(true);

      await terminal.reattach();

      expect(await terminal.wheelReportsToApp()).toBe(true);
    });
  });
});
