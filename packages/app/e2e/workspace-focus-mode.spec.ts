import { expect, test } from "./fixtures";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

async function pressFocusModeShortcut(page: import("@playwright/test").Page) {
  await page.keyboard.press(`${modifier}+Shift+F`);
}

async function pressSettingsShortcut(page: import("@playwright/test").Page) {
  await page.keyboard.press(`${modifier}+Comma`);
}

test("focus mode only applies to the active workspace screen", async ({ page, withWorkspace }) => {
  const workspace = await withWorkspace({ prefix: "focus-mode-boundary-" });
  await workspace.navigateTo();
  const exitFocusMode = page.getByRole("button", { name: "Exit focus mode" });

  await expect(page.getByTestId("sidebar-settings")).toBeVisible();
  await expect(exitFocusMode).toHaveCount(0);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pressFocusModeShortcut(page);

  await expect(exitFocusMode).toBeVisible();
  await expect(page.getByTestId("sidebar-settings")).toHaveCount(0);
  const workspaceUrl = page.url();

  await pressSettingsShortcut(page);

  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await expect(exitFocusMode).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await expect(exitFocusMode).toHaveCount(0);

  await pressFocusModeShortcut(page);
  await page.goto(workspaceUrl);

  await expect(exitFocusMode).toBeVisible();
  await exitFocusMode.click();

  await expect(exitFocusMode).toHaveCount(0);
  await expect(page.getByTestId("sidebar-settings")).toBeVisible();
});
