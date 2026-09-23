import {
  clickNewChat,
  clickNewTerminal,
  gotoWorkspace,
} from "../../app/e2e/support/helpers/launcher";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { renameModalInput, renameModalSubmit } from "../../app/e2e/support/helpers/rename";
import { composerLocator } from "../../app/e2e/support/helpers/composer";
import { runWorkspaceActionFromCommandCenter } from "../../app/e2e/support/helpers/command-center-workspace-actions";
import { waitForWorkspaceTabsVisible } from "../../app/e2e/support/helpers/workspace-tabs";
import { clickSettingsBackToWorkspace } from "../../app/e2e/support/helpers/settings";
import type { Page, TestInfo } from "@playwright/test";
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

async function bindShortcut(page: Page, input: { id: string; combo: string }): Promise<void> {
  await page.getByTestId(`shortcut-actions-${input.id}`).click();
  await page.getByTestId(`shortcut-bind-${input.id}`).click();
  await page.keyboard.press(input.combo);
  await page.getByRole("button", { name: "Done", exact: true }).click();
}

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

async function openShortcutWorkspace(page: Page, workspaceId: string) {
  await installDesktopBridge(page);
  await gotoWorkspace(page, workspaceId);
}

async function configureShortcut(page: Page, input: { id: string; combo: string }) {
  await openSettings(page);
  await openSettingsSection(page, "shortcuts");
  await bindShortcut(page, input);
  await clickSettingsBackToWorkspace(page);
}

async function expectRenameChoices(page: Page) {
  await expect(page.getByTestId("shortcut-actions-workspace-rename")).toBeVisible();
  await expect(page.getByTestId("shortcut-actions-workspace-tab-rename-current")).toBeVisible();
}

async function expectPaneFocusPreference(page: Page, enabled: boolean) {
  await expect(page.getByTestId("pane-focus-text-fields-toggle")).toBeChecked({ checked: enabled });
}

async function changePaneFocusPreference(page: Page, enabled: boolean) {
  const toggle = page.getByTestId("pane-focus-text-fields-toggle");
  await expect(toggle).toBeChecked({ checked: !enabled });
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: enabled });
  await expect(toggle).toBeEnabled();
}

async function reloadShortcutSettings(page: Page) {
  await page.reload();
  await openSettings(page);
  await openSettingsSection(page, "shortcuts");
}

async function captureRenameSettings(page: Page, testInfo: TestInfo) {
  await page.getByTestId("shortcut-actions-workspace-rename").scrollIntoViewIfNeeded();
  await expect(
    page.getByText("Unable to load desktop daemon status.", { exact: true }),
  ).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("shortcut-settings.png"), fullPage: true });
  await page
    .getByTestId("shortcut-actions-workspace-tab-rename-current")
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: testInfo.outputPath("tab-shortcut-settings.png"), fullPage: true });
}

async function renameUsingShortcut(
  page: Page,
  input: { combo: string; modal: string; title: string },
) {
  await page.keyboard.press(input.combo);
  const field = renameModalInput(page, input.modal);
  await expect(field).toBeVisible();
  await field.fill(input.title);
  await renameModalSubmit(page, input.modal).click();
  await expect(field).toHaveCount(0);
}

async function expectWorkspaceRenameAfterReload(page: Page, workspaceId: string) {
  await page.reload();
  await expect(page.getByTestId(workspaceRowTestId(workspaceId))).toContainText(
    "Shortcut renamed workspace",
  );
  await page.keyboard.press("Control+Alt+Shift+r");
  await expect(renameModalInput(page, "workspace-rename-modal-global")).toHaveValue(
    "Shortcut renamed workspace",
  );
  await page.keyboard.press("Escape");
}

async function createTerminalTab(page: Page): Promise<string> {
  await clickNewTerminal(page);
  const tab = page.locator('[data-testid^="workspace-tab-terminal_"]').filter({ visible: true });
  await expect(tab).toHaveCount(1);
  const testId = await tab.getAttribute("data-testid");
  if (!testId) throw new Error("Expected terminal tab id");
  return testId.slice("workspace-tab-terminal_".length);
}

async function expectTerminalTitle(page: Page, terminalId: string) {
  await expect(page.getByTestId(`workspace-tab-terminal_${terminalId}`)).toContainText(
    "Shortcut renamed terminal",
  );
}

async function arrangeComposerBesideLauncher(page: Page) {
  await waitForWorkspaceTabsVisible(page);
  await clickNewChat(page);
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await composerLocator(page).fill("Select this text");
}

async function expectComposerKeepsFocus(page: Page) {
  await page.keyboard.press("Meta+Shift+ArrowRight");
  await expect(composerLocator(page)).toBeFocused();
}

async function enablePaneFocusPreference(page: Page) {
  await openSettings(page);
  await openSettingsSection(page, "shortcuts");
  await changePaneFocusPreference(page, true);
  await clickSettingsBackToWorkspace(page);
}

async function expectPaneFocusRoundTrip(page: Page) {
  await composerLocator(page).click();
  await page.keyboard.press("Meta+Shift+ArrowRight");
  await expect(
    page
      .getByTestId("workspace-new-tab-panel")
      .filter({ visible: true })
      .getByRole("button", { name: "Agent", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Meta+Shift+ArrowLeft");
  await expect(composerLocator(page)).toBeFocused();
}

async function createTwoDraftTabs(page: Page) {
  await clickNewChat(page);
  await clickNewChat(page);
  await expect(
    page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true }),
  ).toHaveCount(2);
}

async function configureTabNumberShortcut(page: Page, testInfo: TestInfo) {
  await openSettings(page);
  await openSettingsSection(page, "shortcuts");
  await bindShortcut(page, { id: "workspace-tab-jump-index", combo: "Control+1" });
  await expect(page.getByText("⌃1-9", { exact: true })).toBeVisible();
  await page.getByTestId("shortcut-actions-workspace-tab-jump-index").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("tab-number-shortcut.png") });
  await clickSettingsBackToWorkspace(page);
}

async function expectTabNumberNavigation(page: Page) {
  const tabs = page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true });
  await page.keyboard.press("Control+1");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+2");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
}

async function reloadWorkspace(page: Page) {
  await page.reload();
  await waitForWorkspaceTabsVisible(page);
}

test.describe("Rename and editable shortcut preferences", () => {
  test.use({ viewport: { width: 1280, height: 1100 } });
  test("shows rename choices and persists the text-field toggle", async ({ page }, testInfo) => {
    await openShortcutsSettings(page);
    await expectRenameChoices(page);
    await expectPaneFocusPreference(page, false);
    await changePaneFocusPreference(page, true);
    await reloadShortcutSettings(page);
    await expectPaneFocusPreference(page, true);
    await captureRenameSettings(page, testInfo);
    await changePaneFocusPreference(page, false);
    await reloadShortcutSettings(page);
    await expectPaneFocusPreference(page, false);
  });
});

test("settings-bound workspace rename persists after reload", async ({ page, withWorkspace }) => {
  const workspace = await withWorkspace({ prefix: "shortcut-workspace-rename-" });
  await openShortcutWorkspace(page, workspace.workspaceId);
  await configureShortcut(page, { id: "workspace-rename", combo: "Control+Alt+Shift+r" });
  await renameUsingShortcut(page, {
    combo: "Control+Alt+Shift+r",
    modal: "workspace-rename-modal-global",
    title: "Shortcut renamed workspace",
  });
  await expectWorkspaceRenameAfterReload(page, workspace.workspaceId);
});

test("settings-bound current tab rename updates the focused terminal", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "shortcut-tab-rename-" });
  await openShortcutWorkspace(page, workspace.workspaceId);
  const terminalId = await createTerminalTab(page);
  await configureShortcut(page, { id: "workspace-tab-rename-current", combo: "Control+Alt+r" });
  await renameUsingShortcut(page, {
    combo: "Control+Alt+r",
    modal: `workspace-tab-rename-modal-terminal-${terminalId}`,
    title: "Shortcut renamed terminal",
  });
  await expectTerminalTitle(page, terminalId);
});

test("the toggle enables pane navigation from the composer", async ({ page, withWorkspace }) => {
  const workspace = await withWorkspace({ prefix: "pane-focus-text-field-" });
  await openShortcutWorkspace(page, workspace.workspaceId);
  await arrangeComposerBesideLauncher(page);
  await expectComposerKeepsFocus(page);
  await enablePaneFocusPreference(page);
  await expectPaneFocusRoundTrip(page);
});

test("rebinding Jump to tab to Ctrl+1 captures all tab numbers", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "shortcut-tab-index-" });
  await openShortcutWorkspace(page, workspace.workspaceId);
  await createTwoDraftTabs(page);
  await configureTabNumberShortcut(page, testInfo);
  await expectTabNumberNavigation(page);
  await reloadWorkspace(page);
  await expectTabNumberNavigation(page);
});
