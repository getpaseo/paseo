import type { Page } from "@playwright/test";
import { test, expect } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { openSettingsSection } from "../../app/e2e/support/helpers/settings";

// Settings > Keyboard Shortcuts is desktop-only (`desktopOnly` in
// settings-screen.tsx), and the gate reads `getIsElectronRuntime()`, which only
// checks for `window.paseoDesktop` -- so this belongs in the desktop suite even
// though no `.electron.*` module sits in the surface's import path.
const SHORTCUTS_ROW = "show-shortcuts";

/**
 * The smallest bridge that makes the app believe it is Electron. The built-in
 * daemon is left unmanaged so the app talks to the E2E daemon instead of trying
 * to start one of its own.
 */
async function installDesktopBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.paseoDesktop = {
      platform: "darwin",
      events: { on: () => () => {} },
      invoke: async (command: string) => {
        if (command === "get_desktop_settings") {
          return {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
          };
        }
        return null;
      },
    };
  });
}

async function openShortcutsSettings(page: Page) {
  await installDesktopBridge(page);
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "shortcuts");
  await expect(page.getByText("Show keyboard shortcuts", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Every row action lives behind the row's actions menu, so which actions a row
 * offers can only be asserted while that menu is open.
 */
async function openRowMenu(page: Page) {
  await page.getByTestId(`shortcut-actions-${SHORTCUTS_ROW}`).click();
  await expect(page.getByTestId(`shortcut-bind-${SHORTCUTS_ROW}`)).toBeVisible();
}

/** Reachable from the sidebar even when the cheat sheet's own shortcut is gone. */
async function openCheatSheet(page: Page) {
  await gotoAppShell(page);
  await page.getByTestId("sidebar-help").click();
  await expect(page.getByTestId("sidebar-help-menu")).toBeVisible();
  await page.getByTestId("sidebar-help-shortcuts").click();
  const dialog = page.getByTestId("keyboard-shortcuts-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

async function closeRowMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`shortcut-bind-${SHORTCUTS_ROW}`)).toHaveCount(0);
}

test("unassigning a shortcut leaves it inert until it is reset", async ({ page }) => {
  await openShortcutsSettings(page);

  const clear = page.getByTestId(`shortcut-clear-${SHORTCUTS_ROW}`);
  const reset = page.getByTestId(`shortcut-reset-${SHORTCUTS_ROW}`);
  const bind = page.getByTestId(`shortcut-bind-${SHORTCUTS_ROW}`);
  const notSet = page.getByText("Not set", { exact: true });
  const dialog = page.getByTestId("keyboard-shortcuts-dialog");

  // The shortcut fires before it is cleared, so the assertion after clearing
  // measures the change rather than a shortcut that never worked.
  await page.keyboard.press("Shift+?");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });

  await openRowMenu(page);
  await expect(clear).toBeVisible();
  await expect(reset).toHaveCount(0);
  await expect(bind).toHaveText("Rebind");
  await clear.click();

  await expect(notSet).toBeVisible();
  await openRowMenu(page);
  await expect(clear).toHaveCount(0);
  await expect(reset).toBeVisible();
  // Nothing is bound now, so the item stops offering to *re*-bind.
  await expect(bind).toHaveText("Bind");
  await closeRowMenu(page);

  await page.keyboard.press("Shift+?");
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });

  // The unassignment has to survive a restart, or "cleared" is only a UI state.
  // A reload lands back on the app shell, so Settings has to be reopened before
  // the section is reachable.
  await page.reload();
  await openSettings(page);
  await openSettingsSection(page, "shortcuts");
  await expect(notSet).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Shift+?");
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });

  await test.step("show the cleared shortcut in help, then bind new keys", async () => {
    const help = await openCheatSheet(page);
    const row = help.getByTestId(`shortcut-help-row-${SHORTCUTS_ROW}`);
    await expect(row.getByText("Not set", { exact: true })).toBeVisible();
    await expect(help.getByText("?", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await openSettings(page);
    await openSettingsSection(page, "shortcuts");

    await openRowMenu(page);
    await bind.click();
    await page.keyboard.press("Alt+Shift+K");
    await page.getByText("Done", { exact: true }).click();
    await expect(page.getByText("⌥⇧K", { exact: true })).toBeVisible();
    const reboundHelp = await openCheatSheet(page);
    const reboundRow = reboundHelp.getByTestId(`shortcut-help-row-${SHORTCUTS_ROW}`);
    await expect(reboundRow.getByText("⌥⇧K", { exact: true })).toBeVisible();
    await expect(reboundRow.getByText("?", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await openSettings(page);
    await openSettingsSection(page, "shortcuts");
  });

  await openRowMenu(page);
  await page.getByTestId(`shortcut-reset-${SHORTCUTS_ROW}`).click();
  await expect(notSet).toHaveCount(0);
  await openRowMenu(page);
  await expect(page.getByTestId(`shortcut-clear-${SHORTCUTS_ROW}`)).toBeVisible();
  await expect(page.getByTestId(`shortcut-bind-${SHORTCUTS_ROW}`)).toHaveText("Rebind");
  await closeRowMenu(page);

  await page.keyboard.press("Shift+?");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
});
