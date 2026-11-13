import { expect, test } from "../support/fixtures";
import { clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

// The browser owns Cmd+Shift+brackets for its own tabs, so web keeps
// Alt+Shift+brackets on every OS. Desktop bindings live in the desktop suite.
test("web switches to the previous and next tab with Alt+Shift+[ and ]", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "tab-relative-web-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);
    const terminalTabs = page
      .locator('[data-testid^="workspace-tab-terminal_"]')
      .filter({ visible: true });
    await clickNewTerminal(page);
    await expect(terminalTabs).toHaveCount(1, { timeout: 30_000 });
    await clickNewTerminal(page);
    await expect(terminalTabs).toHaveCount(2, { timeout: 30_000 });
    const first = terminalTabs.nth(0);
    const second = terminalTabs.nth(1);
    await expect(second).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Alt+Shift+BracketLeft");
    await expect(first).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Alt+Shift+BracketRight");
    await expect(second).toHaveAttribute("aria-selected", "true");
  } finally {
    await workspace.cleanup();
  }
});
