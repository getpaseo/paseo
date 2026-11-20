import { expect, test, type Page } from "../support/fixtures";

// "Toggle command center" recorded as a two-key sequence. Both platform
// bindings are overridden so the spec does not depend on the host OS.
const COMMAND_CENTER_SEQUENCE = {
  "command-center-toggle-cmd-k-mac": "Cmd+K J",
  "command-center-toggle-ctrl-k-non-mac": "Ctrl+K J",
};

const SEQUENCE_PREFIX = process.platform === "darwin" ? "Meta+K" : "Control+K";
const SEQUENCE_FINAL_KEY = "j";

/** Record the sequence in Settings → Keyboard shortcuts, through its storage. */
async function recordCommandCenterSequence(page: Page): Promise<void> {
  await page.addInitScript((overrides) => {
    localStorage.setItem("@paseo:keyboard-shortcut-overrides", JSON.stringify(overrides));
  }, COMMAND_CENTER_SEQUENCE);
}

/**
 * Resize the window and let the app render again, so the resize lands between
 * the two keys of the sequence rather than after them.
 */
async function resizeWindowAndSettle(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.waitForFunction((expected) => window.innerWidth === expected, width);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function expectCommandCenterOpen(page: Page): Promise<void> {
  await expect(page.getByTestId("command-center-panel")).toBeVisible({ timeout: 30_000 });
}

test.describe("Multi-key shortcut sequences", () => {
  test("a recorded sequence opens the command center", async ({ page, withWorkspace }) => {
    await recordCommandCenterSequence(page);
    const workspace = await withWorkspace({ prefix: "shortcut-sequence-" });
    await workspace.navigateTo();

    await page.keyboard.press(SEQUENCE_PREFIX);
    await page.keyboard.press(SEQUENCE_FINAL_KEY);

    await expectCommandCenterOpen(page);
  });

  test("a sequence completes when the window resizes between its keys", async ({
    page,
    withWorkspace,
  }) => {
    await recordCommandCenterSequence(page);
    const workspace = await withWorkspace({ prefix: "shortcut-sequence-resize-" });
    await workspace.navigateTo();

    await page.keyboard.press(SEQUENCE_PREFIX);
    await resizeWindowAndSettle(page, 1100);
    await page.keyboard.press(SEQUENCE_FINAL_KEY);

    await expectCommandCenterOpen(page);
  });
});
