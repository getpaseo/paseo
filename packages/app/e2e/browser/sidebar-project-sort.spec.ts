import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { closeSidebarDisplayPreferences, openSidebarDisplayPage } from "../support/helpers/sidebar";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function rowTestIds(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

// The immediate-drag gesture from sidebar-reorder.spec.ts, trimmed to project rows.
async function dragFirstRowAfterSecond(rows: Locator) {
  const before = await rowTestIds(rows);
  const sourceBox = await rows.nth(0).boundingBox();
  const targetBox = await rows.nth(1).boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Expected two visible project rows");

  const page = rows.page();
  const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y + 7);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
  return [before[1], before[0]];
}

async function selectProjectSort(page: Page, mode: "manual" | "recent") {
  await openSidebarDisplayPage(page, "sidebar-display-project-sort");
  await page.getByTestId(`sidebar-project-sort-${mode}`).click();
  await closeSidebarDisplayPreferences(page);
}

test("recent-activity sort reorders projects live and leaves the manual order alone", async ({
  page,
}) => {
  const olderProject = await seedWorkspace({ repoPrefix: "sidebar-sort-older-" });
  const newerProject = await seedWorkspace({ repoPrefix: "sidebar-sort-newer-" });

  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const olderRow = `sidebar-project-row-${projectEquivalenceViewKey(olderProject.projectKey)}`;
    const newerRow = `sidebar-project-row-${projectEquivalenceViewKey(newerProject.projectKey)}`;
    const rows = page.locator(`[data-testid="${olderRow}"], [data-testid="${newerRow}"]`);
    await expect(rows).toHaveCount(2);

    // Establish a manual order the sort cannot mistake for its own output: whatever the
    // appearance order is, reverse it by drag.
    const manualOrder = await dragFirstRowAfterSecond(rows);

    // The newer project holds the freshest workspace activity, so recency puts it on top.
    await selectProjectSort(page, "recent");
    await expect.poll(() => rowTestIds(rows)).toEqual([newerRow, olderRow]);

    // Fresh activity in the older project bumps it to the top without any manual reorder.
    const bump = await olderProject.client.createWorkspace({
      source: {
        kind: "directory",
        path: olderProject.repoPath,
        projectId: olderProject.projectId,
      },
      title: "Freshest workspace",
    });
    if (!bump.workspace) throw new Error(bump.error ?? "Failed to seed the bump workspace");
    await expect.poll(() => rowTestIds(rows)).toEqual([olderRow, newerRow]);

    // The preference survives a reload. The persisted sidebar-view schema is strict, so an
    // unknown key would reset every sidebar setting on parse.
    await page.reload();
    await waitForSidebarHydration(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([olderRow, newerRow]);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-project-sort")).toContainText("Recent activity");
    await closeSidebarDisplayPreferences(page);

    // Switching back to manual restores the dragged order untouched.
    await selectProjectSort(page, "manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(manualOrder);
  } finally {
    await olderProject.cleanup();
    await newerProject.cleanup();
  }
});
