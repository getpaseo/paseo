import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";

// Where Settings → Keyboard shortcuts persists a rebound shortcut.
const OVERRIDE_STORAGE_KEY = "@paseo:keyboard-shortcut-overrides";
const COMMAND_CENTER_BINDING = "command-center-toggle-ctrl-k-non-mac";

async function rebindCommandCenter(page: Page, combo: string): Promise<void> {
  await page.addInitScript(
    ([key, bindingId, value]) => {
      window.localStorage.setItem(key, JSON.stringify({ [bindingId]: value }));
    },
    [OVERRIDE_STORAGE_KEY, COMMAND_CENTER_BINDING, combo] as const,
  );
  await gotoAppShell(page);
  await expect(page.getByTestId("sidebar-search")).toBeVisible({ timeout: 30_000 });
}

async function expectCommandCenterOpen(page: Page): Promise<void> {
  await expect(page.getByTestId("command-center-panel")).toBeVisible({ timeout: 10_000 });
}

test.describe("Multi-step shortcut", () => {
  test("completes a chord whose second step is a bare key", async ({ page }) => {
    await rebindCommandCenter(page, "Ctrl+K J");

    await page.keyboard.press("Control+k");
    await page.keyboard.press("j");

    await expectCommandCenterOpen(page);
  });

  // Releasing Ctrl between the steps makes the browser emit a bare `Control`
  // keydown before `Ctrl+J`, which used to reset the chord to its first step.
  test("completes a chord whose second step carries a modifier", async ({ page }) => {
    await rebindCommandCenter(page, "Ctrl+K Ctrl+J");

    await page.keyboard.press("Control+k");
    await page.keyboard.press("Control+j");

    await expectCommandCenterOpen(page);
  });
});
