import { expect, test, type Page } from "../support/fixtures";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

async function pressFocusModeShortcut(page: Page) {
  await page.keyboard.press(`${modifier}+Shift+F`);
}

async function pressSettingsShortcut(page: Page) {
  await page.keyboard.press(`${modifier}+Comma`);
}

async function pressRightSidebarShortcut(page: Page) {
  await page.keyboard.press(`${modifier}+E`);
}

async function returnToWorkspace(page: Page, workspaceUrl: string) {
  await page.goto(workspaceUrl);
}

async function blurActiveElement(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

function exitFocusModeButton(page: Page) {
  return page.getByRole("button", { name: "Exit focus mode" });
}

async function enterFocusMode(page: Page) {
  await blurActiveElement(page);
  await pressFocusModeShortcut(page);
  await expect(exitFocusModeButton(page)).toBeVisible();
}

test("sidebar shortcuts exit focus mode and execute their action", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "focus-mode-sidebar-shortcut-" });
  await workspace.navigateTo();
  await enterFocusMode(page);

  await pressRightSidebarShortcut(page);

  await expect(exitFocusModeButton(page)).toHaveCount(0);
  await expect(
    page.getByText("Changes", { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible();
});

test("sidebar shortcuts outside a workspace preserve its focus mode", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "focus-mode-sidebar-boundary-" });
  await workspace.navigateTo();
  await enterFocusMode(page);
  const workspaceUrl = page.url();

  await pressSettingsShortcut(page);
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();

  await pressRightSidebarShortcut(page);
  await returnToWorkspace(page, workspaceUrl);

  await expect(exitFocusModeButton(page)).toBeVisible();
});

test("focus mode only applies to the active workspace screen", async ({ page, withWorkspace }) => {
  const workspace = await withWorkspace({ prefix: "focus-mode-boundary-" });
  await workspace.navigateTo();
  const exitFocusMode = exitFocusModeButton(page);
  const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
  const settingsSidebar = page.getByRole("navigation", { name: "Settings" });

  await expect(settingsButton).toBeVisible();
  await expect(exitFocusMode).toHaveCount(0);

  await blurActiveElement(page);
  await pressFocusModeShortcut(page);

  await expect(exitFocusMode).toBeVisible();
  await expect(settingsButton).toHaveCount(0);
  const workspaceUrl = page.url();

  await pressSettingsShortcut(page);

  await expect(settingsSidebar).toBeVisible();
  await expect(exitFocusMode).toHaveCount(0);

  await page.reload();
  await expect(settingsSidebar).toBeVisible();
  await expect(exitFocusMode).toHaveCount(0);

  await pressFocusModeShortcut(page);
  await returnToWorkspace(page, workspaceUrl);

  await expect(exitFocusMode).toBeVisible();
  await exitFocusMode.click();

  await expect(exitFocusMode).toHaveCount(0);
  await expect(settingsButton).toBeVisible();
});
