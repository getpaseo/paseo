import type { Page } from "@playwright/test";
import { test, expect } from "../../app/e2e/support/fixtures";
import { clickNewTerminal, gotoWorkspace } from "../../app/e2e/support/helpers/launcher";
import { seedWorkspace } from "../../app/e2e/support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../../app/e2e/support/helpers/workspace-tabs";

// macOS desktop switches tabs with Cmd+Shift+brackets, like other Mac apps.
// Web keeps Alt+Shift (the browser owns Cmd+Shift+brackets) and is covered in
// the app browser suite. Windows/Linux desktop can't be emulated here: shortcut
// OS detection falls back to the host user agent for non-darwin bridges.

async function installMacDesktopBridge(page: Page): Promise<void> {
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

const terminalTabs = (page: Page) =>
  page.locator('[data-testid^="workspace-tab-terminal_"]').filter({ visible: true });

async function openTwoTerminalTabs(page: Page) {
  await waitForWorkspaceTabsVisible(page);
  await clickNewTerminal(page);
  await expect(terminalTabs(page)).toHaveCount(1, { timeout: 30_000 });
  await clickNewTerminal(page);
  await expect(terminalTabs(page)).toHaveCount(2, { timeout: 30_000 });
  const first = terminalTabs(page).nth(0);
  const second = terminalTabs(page).nth(1);
  await expect(second).toHaveAttribute("aria-selected", "true");
  return { first, second };
}

test.describe("Previous/next tab shortcuts on desktop", () => {
  test("macOS desktop switches tabs with Cmd+Shift+[ and ], not Alt+Shift", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "tab-relative-mac-desktop-" });
    try {
      await installMacDesktopBridge(page);
      await gotoWorkspace(page, workspace.workspaceId);
      const { first, second } = await openTwoTerminalTabs(page);

      await page.keyboard.press("Meta+Shift+BracketLeft");
      await expect(first).toHaveAttribute("aria-selected", "true");

      await page.keyboard.press("Meta+Shift+BracketRight");
      await expect(second).toHaveAttribute("aria-selected", "true");

      // Alt+Shift is the web and Windows/Linux binding and must not fire here.
      // Had it moved to the first tab, Cmd+Shift+[ would wrap back to the second.
      await page.keyboard.press("Alt+Shift+BracketLeft");
      await page.keyboard.press("Meta+Shift+BracketLeft");
      await expect(first).toHaveAttribute("aria-selected", "true");
    } finally {
      await workspace.cleanup();
    }
  });
});
