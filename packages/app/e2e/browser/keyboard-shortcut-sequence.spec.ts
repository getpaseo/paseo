import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

// A two-step sequence for "Toggle command center", on both the mac and non-mac
// binding so the spec does not depend on the host OS.
const SEQUENCE_OVERRIDES = {
  "command-center-toggle-ctrl-k-non-mac": "Ctrl+K J",
  "command-center-toggle-cmd-k-mac": "Cmd+K J",
};

async function seedSequenceOverride(page: Page): Promise<void> {
  await page.addInitScript((overrides) => {
    localStorage.setItem("@paseo:keyboard-shortcut-overrides", JSON.stringify(overrides));
  }, SEQUENCE_OVERRIDES);
}

function commandCenter(page: Page) {
  return page.getByTestId("command-center-panel");
}

// The resize only matters once the browser has delivered it and the app has
// rendered again, so settle two frames before the second key.
async function resizeAndSettle(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.waitForFunction((expected) => window.innerWidth === expected, width);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function pressSequenceStart(page: Page): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+K`);
}

test.describe("multi-key shortcut sequences", () => {
  test("a sequence completes when the window resizes between its keys", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "shortcut-sequence-resize-" });

    try {
      await seedSequenceOverride(page);
      await gotoWorkspace(page, workspace.workspaceId);

      // Control: the sequence works when nothing re-renders between the keys.
      await pressSequenceStart(page);
      await page.keyboard.press("j");
      await expect(commandCenter(page)).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Escape");
      await expect(commandCenter(page)).not.toBeVisible();

      // The reported failure: the root layout re-renders between the two keys.
      await pressSequenceStart(page);
      await resizeAndSettle(page, 1100);
      await page.keyboard.press("j");

      await expect(commandCenter(page)).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});
