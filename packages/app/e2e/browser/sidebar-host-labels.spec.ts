import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openSidebarDisplayPreferences } from "../support/helpers/hosts";
import { clickSettingsBackToWorkspace, openSettingsSection } from "../support/helpers/settings";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test("always-show host labels is a client Appearance setting", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "sidebar-host-labels-" });
  try {
    const serverId = getServerId();
    const hostBadge = page
      .getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`)
      .getByTestId(`host-badge-${serverId}`);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await expect(hostBadge).toHaveCount(0);

    await openSettings(page);
    await openSettingsSection(page, "appearance");
    const alwaysShowHostLabels = page.getByTestId("app-settings-always-show-host-labels");
    await expect(alwaysShowHostLabels).toHaveAttribute("aria-checked", "false");
    await alwaysShowHostLabels.click();
    await expect(alwaysShowHostLabels).toHaveAttribute("aria-checked", "true");

    await clickSettingsBackToWorkspace(page);
    await expect(hostBadge).toBeVisible();

    await openSidebarDisplayPreferences(page);
    await page.getByTestId("sidebar-display-show").click();
    const sidebarShortcut = page.getByTestId("sidebar-always-show-host-labels");
    await expect(sidebarShortcut).toHaveAttribute("aria-checked", "true");
    await sidebarShortcut.click();
    await expect(sidebarShortcut).toHaveAttribute("aria-checked", "false");
    await expect(hostBadge).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
