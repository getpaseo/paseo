import { dragTabAfter, openIndependentCompactClient } from "../support/helpers/shared-order";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  openMobileAgentSidebar,
  expectMobileAgentSidebarVisible,
  closeMobileAgentSidebar,
} from "../support/helpers/sidebar";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

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

async function pressProjectRow(rows: Locator) {
  await rows.page().mouse.down();
}

async function pressWorkspaceRow(rows: Locator) {
  const solidScrimStop = rows
    .nth(0)
    .getByTestId("sidebar-workspace-trailing-scrim")
    .locator("stop")
    .nth(1);
  const hoverScrimColor = await solidScrimStop.getAttribute("stop-color");
  await rows.page().mouse.down();
  await expect.poll(() => solidScrimStop.getAttribute("stop-color")).not.toBe(hoverScrimColor);
}

async function quickDragFirstRowAfterSecond(
  rows: Locator,
  pressRow: (rows: Locator) => Promise<void>,
) {
  await expect(rows).toHaveCount(2);
  const before = await rowTestIds(rows);
  const sourceBox = await visibleBoundingBox(rows.nth(0));
  const targetBox = await visibleBoundingBox(rows.nth(1));

  const page = rows.page();
  const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(source.x, source.y);
  const trailingScrim = rows.nth(0).getByTestId("sidebar-workspace-trailing-scrim");
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
  await expect(trailingScrim).toHaveCount(0);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
}

test("projects, workspaces, and pinned chats reorder with an immediate mouse drag", async ({
  page,
}) => {
  const firstProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-first-" });
  const secondProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-second-" });

  try {
    const secondWorkspace = await firstProject.client.createWorkspace({
      source: {
        kind: "directory",
        path: firstProject.repoPath,
        projectId: firstProject.projectId,
      },
      title: "Second workspace",
    });
    if (!secondWorkspace.workspace) {
      throw new Error(secondWorkspace.error ?? "Failed to seed a second workspace");
    }

    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const firstProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(firstProject.projectKey)}`;
    const secondProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(secondProject.projectKey)}`;
    await quickDragFirstRowAfterSecond(
      page.locator(`[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`),
      pressProjectRow,
    );
    const firstWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${firstProject.workspaceId}`;
    const secondWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondWorkspace.workspace.id}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );

    await firstProject.client.setWorkspacePinned(firstProject.workspaceId, true);
    await secondProject.client.setWorkspacePinned(secondProject.workspaceId, true);
    const secondProjectWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondProject.workspaceId}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );
  } finally {
    await firstProject.cleanup();
    await secondProject.cleanup();
  }
});

async function captureOrderingScreenshot(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

async function agentTabIds(page: Page): Promise<Array<string | null>> {
  return rowTestIds(
    page.locator('[data-testid^="workspace-tab-agent_"]').filter({ visible: true }),
  );
}

async function compactAgentTabIds(page: Page): Promise<Array<string | null>> {
  const ids = await rowTestIds(
    page
      .locator('[data-testid^="workspace-tab-menu-agent_"][data-testid$="-trigger"]')
      .filter({ visible: true }),
  );
  return ids.map(
    (id) => id?.replace("workspace-tab-menu-", "workspace-tab-").replace(/-trigger$/, "") ?? null,
  );
}

async function openCompactTabs(page: Page): Promise<void> {
  await page.getByTestId("workspace-tab-switcher-trigger").click();
  await expect(page.getByTestId("workspace-tab-switcher-new-terminal")).toBeInViewport({
    ratio: 1,
  });
}

async function closeCompactTabs(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Bottom sheet backdrop" })
    .click({ position: { x: 10, y: 10 } });
  await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
}

test("workspace and tab reorder propagate to an independent compact client and survive reload", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const seed = await seedWorkspace({ repoPrefix: "shared-order-", title: "First" });
  let secondContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const created = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "Second",
    });
    if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
    const a = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: seed.workspaceId,
      title: "Agent A",
    });
    const b = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: seed.workspaceId,
      title: "Agent B",
    });
    await gotoWorkspace(page, seed.workspaceId);
    await waitForSidebarHydration(page);
    const independent = await openIndependentCompactClient({ browser, page });
    secondContext = independent.context;
    const compact = independent.page;
    await expect.poll(() => agentTabIds(page)).toHaveLength(2);
    const beforeTabs = await agentTabIds(page);
    await openCompactTabs(compact);
    await expect.poll(() => compactAgentTabIds(compact)).toEqual(beforeTabs);
    await closeCompactTabs(compact);
    const workspaceSelector = `[data-testid="sidebar-workspace-row-${getServerId()}:${seed.workspaceId}"], [data-testid="sidebar-workspace-row-${getServerId()}:${created.workspace.id}"]`;
    const rows = page.locator(workspaceSelector);
    const beforeRows = await rowTestIds(rows);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await openMobileAgentSidebar(compact);
    await expectMobileAgentSidebarVisible(compact);
    await expect
      .poll(() => rowTestIds(compact.locator(workspaceSelector)))
      .toEqual(beforeRows.toReversed());
    await captureOrderingScreenshot(compact, testInfo, "compact-shared-workspace-order");
    await quickDragFirstRowAfterSecond(compact.locator(workspaceSelector), pressWorkspaceRow);
    await expect.poll(() => rowTestIds(rows)).toEqual(beforeRows);
    await closeMobileAgentSidebar(compact);
    const initialTabs = await agentTabIds(page);
    expect(initialTabs).toEqual(
      expect.arrayContaining([`workspace-tab-agent_${a.id}`, `workspace-tab-agent_${b.id}`]),
    );
    await dragTabAfter({ page, sourceTestId: initialTabs[0]!, targetTestId: initialTabs[1]! });
    await expect.poll(() => agentTabIds(page)).toEqual(initialTabs.toReversed());
    await openCompactTabs(compact);
    await expect.poll(() => compactAgentTabIds(compact)).toEqual(initialTabs.toReversed());
    await captureOrderingScreenshot(page, testInfo, "desktop-shared-tab-order");
    await captureOrderingScreenshot(compact, testInfo, "compact-shared-tab-order");
    await compact.reload();
    await openCompactTabs(compact);
    await expect.poll(() => compactAgentTabIds(compact)).toEqual(initialTabs.toReversed());
    await closeCompactTabs(compact);
    await openMobileAgentSidebar(compact);
    await expectMobileAgentSidebarVisible(compact);
    await expect.poll(() => rowTestIds(compact.locator(workspaceSelector))).toEqual(beforeRows);
    await seed.client.setWorkspacePinned(seed.workspaceId, true);
    await seed.client.setWorkspacePinned(created.workspace.id, true);
    const pinnedBefore = await rowTestIds(rows);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await expect
      .poll(() => rowTestIds(compact.locator(workspaceSelector)))
      .toEqual(pinnedBefore.toReversed());
    await captureOrderingScreenshot(compact, testInfo, "compact-shared-pinned-order");
    await independent.setOffline({ offline: true });
    const offlineRows = compact.locator(workspaceSelector);
    const beforeOfflineMove = await rowTestIds(offlineRows);
    await quickDragFirstRowAfterSecond(offlineRows, pressWorkspaceRow);
    await expect.poll(() => rowTestIds(rows)).toEqual(beforeOfflineMove);
    await independent.setOffline({ offline: false });
    await expect
      .poll(() => rowTestIds(rows), { timeout: 30_000 })
      .toEqual(beforeOfflineMove.toReversed());
    await captureOrderingScreenshot(compact, testInfo, "compact-offline-shared-pinned-order");
  } finally {
    await secondContext?.close();
    await seed.cleanup();
  }
});
