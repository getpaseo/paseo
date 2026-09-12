import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openSidebarDisplayPage } from "../support/helpers/sidebar";
import { getServerId } from "../support/helpers/server-id";

test("Show includes the sidebar row density preferences", async ({ page }) => {
  const seeded = await seedWorkspace({ repoPrefix: "sidebar-display-preferences-" });

  try {
    await gotoAppShell(page);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`),
    ).toBeVisible({ timeout: 30_000 });
    await openSidebarDisplayPage(page, "sidebar-display-show");

    await expect(page.getByTestId("sidebar-layout-compactRows")).toHaveText("Compact rows");
    await expect(page.getByTestId("sidebar-layout-newWorkspaceRow")).toHaveText(
      "New workspace row",
    );
  } finally {
    await seeded.cleanup();
  }
});
