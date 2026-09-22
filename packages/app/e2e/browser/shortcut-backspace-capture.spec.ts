import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openSettingsSection } from "../support/helpers/settings";

async function openShortcutActions(page: Page, action: string): Promise<void> {
  await page.getByTestId(`shortcut-actions-${action}`).click();
}

async function clearShortcut(page: Page, action: string): Promise<void> {
  await openShortcutActions(page, action);
  await page.getByTestId(`shortcut-clear-${action}`).click();
}

async function startShortcutCapture(page: Page, action: string): Promise<void> {
  await openShortcutActions(page, action);
  await page.getByTestId(`shortcut-bind-${action}`).click();
}

test("binds Backspace to Interrupt agent after freeing the archive shortcut", async ({
  page,
}) => {
  // Show desktop-only shortcut settings in the browser test runtime.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    Object.defineProperty(window, "paseoDesktop", {
      value: { platform: "darwin", events: { on: async () => () => {} } },
    });
  });
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "shortcuts");

  await clearShortcut(page, "archive-workspace");
  await startShortcutCapture(page, "agent-interrupt");
  await page.keyboard.press("Meta+Shift+Backspace");

  const interruptRow = page
    .getByText("Interrupt agent", { exact: true })
    .locator("..");
  await expect(interruptRow.getByText("⇧⌘⌫", { exact: true })).toBeVisible();
  await interruptRow.getByRole("button", { name: "Done" }).click();
  await expect(interruptRow.getByText("⇧⌘⌫", { exact: true })).toBeVisible();

  await startShortcutCapture(page, "agent-interrupt");
  await page.keyboard.press("Backspace");
  await expect(
    interruptRow.getByRole("button", { name: "Done" })
  ).toBeVisible();
  await interruptRow.getByRole("button", { name: "Cancel" }).click();
  await expect(interruptRow.getByText("⇧⌘⌫", { exact: true })).toBeVisible();
});
