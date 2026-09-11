import type { Locator } from "@playwright/test";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { addOfflineHostAndReload, selectAllHostsFilter, toggleHostFilter } from "./helpers/hosts";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

const SECONDARY_HOST_ID = "host-filter-order-secondary";

async function rowTestIds(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

async function visibleBoundingBox(row: Locator) {
  const box = await row.boundingBox();
  if (!box) throw new Error("Expected a visible draggable row");
  return box;
}

// Retry the trigger click: the freshly booted web bundle can re-render the sidebar while the
// first click is in flight, which closes the dropdown before its content mounts.
async function openSidebarDisplayPreferences(page: Page) {
  await expect(async () => {
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-preferences-content")).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
}

async function quickDragFirstRowAfterSecond(rows: Locator) {
  await expect(rows).toHaveCount(2);
  const before = await rowTestIds(rows);
  const sourceBox = await visibleBoundingBox(rows.nth(0));
  const targetBox = await visibleBoundingBox(rows.nth(1));

  const page = rows.page();
  const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y + 7);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
  return { before };
}

test.describe("Sidebar host filter keeps manual order", () => {
  test.describe.configure({ timeout: 120_000 });

  test("manual workspace order survives switching the host filter away and back", async ({
    page,
  }) => {
    const seeded = await seedWorkspace({ repoPrefix: "host-filter-order-" });
    const serverId = getServerId();

    try {
      const secondWorkspace = await seeded.client.createWorkspace({
        source: {
          kind: "directory",
          path: seeded.repoPath,
          projectId: seeded.projectId,
        },
        title: "Second workspace",
      });
      if (!secondWorkspace.workspace) {
        throw new Error(secondWorkspace.error ?? "Failed to seed a second workspace");
      }

      await gotoAppShell(page);
      await addOfflineHostAndReload(page, {
        serverId: SECONDARY_HOST_ID,
        label: "Secondary Host",
      });
      await waitForSidebarHydration(page);

      const firstRowTestId = `sidebar-workspace-row-${serverId}:${seeded.workspaceId}`;
      const secondRowTestId = `sidebar-workspace-row-${serverId}:${secondWorkspace.workspace.id}`;
      const rows = page.locator(
        `[data-testid="${firstRowTestId}"], [data-testid="${secondRowTestId}"]`,
      );
      await expect(rows).toHaveCount(2);

      // Step 1: pin the sidebar to the primary host.
      await openSidebarDisplayPreferences(page);
      await toggleHostFilter(page, serverId);
      await page.keyboard.press("Escape");
      await expect(rows).toHaveCount(2);

      // Step 2: manually reorder the workspaces.
      const { before } = await quickDragFirstRowAfterSecond(rows);
      const reordered = [before[1], before[0]];

      // Step 3: switch the filter to only the secondary host.
      await openSidebarDisplayPreferences(page);
      await toggleHostFilter(page, SECONDARY_HOST_ID);
      await toggleHostFilter(page, serverId);
      await page.keyboard.press("Escape");
      await expect(rows).toHaveCount(0, { timeout: 10_000 });

      // Step 4: switch the filter back to only the primary host.
      await openSidebarDisplayPreferences(page);
      await toggleHostFilter(page, serverId);
      await toggleHostFilter(page, SECONDARY_HOST_ID);
      await page.keyboard.press("Escape");
      await expect(rows).toHaveCount(2, { timeout: 10_000 });

      // The manual order must survive the round trip.
      await expect.poll(() => rowTestIds(rows)).toEqual(reordered);

      // Also check the all-hosts view keeps it.
      await openSidebarDisplayPreferences(page);
      await selectAllHostsFilter(page);
      await page.keyboard.press("Escape");
      await expect(rows).toHaveCount(2, { timeout: 10_000 });
      await expect.poll(() => rowTestIds(rows)).toEqual(reordered);
    } finally {
      await seeded.cleanup();
    }
  });
});
