import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  selectSidebarStatusGrouping,
  openSidebarDisplayPage,
  chooseSidebarSort,
  expectDisplaySortHoverFollowsPointer,
} from "../support/helpers/sidebar";
import {
  openWorkspaceSettings,
  expectRunningFirstSetting,
  setRunningFirst,
} from "../support/helpers/settings";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("display preferences hover follows the pointer without highlighting the first option", async ({
  page,
}) => {
  const seeded = await seedWorkspace({ repoPrefix: "sidebar-hover-" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    for (const scope of ["project", "workspace"] as const) {
      await expectDisplaySortHoverFollowsPointer(page, scope);
    }
  } finally {
    await seeded.cleanup();
  }
});

test("activity-day grouping preserves pins, collapse, preferences, and midnight rollover", async ({
  page,
}) => {
  const active = await seedMockAgentWorkspace({ repoPrefix: "day-active-", title: "Active today" });
  const older = await seedWorkspace({ repoPrefix: "day-older-", title: "No activity" });
  try {
    await active.client.sendAgentMessage(active.agentId, "Reply with hello.");
    await active.client.waitForAgentUpsert(
      active.agentId,
      (snapshot) => snapshot.status === "idle",
      15_000,
    );
    await page.clock.install();
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await chooseSidebarSort(page, "workspace", "name");
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-day").click();
    const activeId = `sidebar-workspace-row-${getServerId()}:${active.workspaceId}`;
    const olderId = `sidebar-workspace-row-${getServerId()}:${older.workspaceId}`;
    const today = page.getByTestId("sidebar-status-group-rows-today");
    await expect(today.getByTestId(activeId)).toBeVisible();
    await expect(
      page.getByTestId("sidebar-status-group-rows-older").getByTestId(olderId),
    ).toBeVisible();
    await older.client.setWorkspacePinned(older.workspaceId, true);
    await expect(page.getByTestId("sidebar-pinned-section").getByTestId(olderId)).toBeVisible();
    await expect(page.getByTestId("sidebar-status-group-older")).toHaveCount(0);
    await page.getByTestId("sidebar-status-group-today").click();
    await expect(today).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("sidebar-status-group-today")).toBeVisible();
    await expect(today).toHaveCount(0);
    await page.getByTestId("sidebar-status-group-today").click();
    await expect(today.getByTestId(activeId)).toBeVisible();
    await openWorkspaceSettings(page);
    await expectRunningFirstSetting(page, "workspace", { enabled: true });
    await expectRunningFirstSetting(page, "project", {
      enabled: false,
      statusText: "Group by Project",
    });
    await gotoAppShell(page);
    await expect(today.getByTestId(activeId)).toBeVisible();
    const untilMidnight = await page.evaluate(() => {
      const current = new Date();
      const midnight = new Date(current);
      midnight.setHours(24, 0, 0, 0);
      return midnight.getTime() - current.getTime() + 2_000;
    });
    await page.clock.fastForward(untilMidnight);
    await expect(
      page.getByTestId("sidebar-status-group-rows-yesterday").getByTestId(activeId),
    ).toBeVisible();
    await expect(page.getByTestId("sidebar-status-group-today")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("activity-day.png") });
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-project").click();
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-workspace-sorting")).toContainText("Name");
    await page.keyboard.press("Escape");
  } finally {
    await active.cleanup();
    await older.cleanup();
  }
});

test("recent-activity sorting follows chat activity, preserves pins, and survives reload", async ({
  page,
}) => {
  const older = await seedMockAgentWorkspace({ repoPrefix: "recent-first-", title: "Older chat" });
  const newer = await seedMockAgentWorkspace({ repoPrefix: "recent-second-", title: "Newer chat" });
  try {
    await newer.client.sendAgentMessage(newer.agentId, "Reply with hello.");
    await newer.client.waitForAgentUpsert(
      newer.agentId,
      (snapshot) => snapshot.status === "idle",
      15_000,
    );
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const olderId = `sidebar-workspace-row-${getServerId()}:${older.workspaceId}`;
    const newerId = `sidebar-workspace-row-${getServerId()}:${newer.workspaceId}`;
    const rows = page.locator(`[data-testid="${olderId}"], [data-testid="${newerId}"]`);
    await chooseSidebarSort(page, "workspace", "recent");
    await chooseSidebarSort(page, "project", "recent");
    await expect.poll(() => rowTestIds(rows)).toEqual([newerId, olderId]);

    await older.client.sendAgentMessage(older.agentId, "Reply with hello.");
    await expect.poll(() => rowTestIds(rows)).toEqual([olderId, newerId]);
    await page.reload();
    await expect.poll(() => rowTestIds(rows)).toEqual([olderId, newerId]);

    await newer.client.setWorkspacePinned(newer.workspaceId, true);
    await expect.poll(() => rowTestIds(rows)).toEqual([newerId, olderId]);
  } finally {
    await older.cleanup();
    await newer.cleanup();
  }
});

test("name sorting blocks dragging and running-first settings depend on each sort mode", async ({
  page,
}) => {
  const first = await seedWorkspace({ repoPrefix: "sort-first-", title: "Workspace 10" });
  const other = await seedWorkspace({ repoPrefix: "sort-other-" });
  try {
    await first.client.renameProject(first.projectId, "Project 10");
    await other.client.renameProject(other.projectId, "Project 2");
    const sibling = await first.client.createWorkspace({
      source: { kind: "directory", path: first.repoPath, projectId: first.projectId },
      title: "Workspace 2",
    });
    if (!sibling.workspace) throw new Error(sibling.error ?? "Failed to create sibling");
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const firstId = `sidebar-workspace-row-${getServerId()}:${first.workspaceId}`;
    const siblingId = `sidebar-workspace-row-${getServerId()}:${sibling.workspace.id}`;
    const firstProjectId = `sidebar-project-row-${projectEquivalenceViewKey(first.projectKey)}`;
    const otherProjectId = `sidebar-project-row-${projectEquivalenceViewKey(other.projectKey)}`;
    const workspaceRows = page.locator(`[data-testid="${firstId}"], [data-testid="${siblingId}"]`);
    const projectRows = page.locator(
      `[data-testid="${firstProjectId}"], [data-testid="${otherProjectId}"]`,
    );
    await chooseSidebarSort(page, "workspace", "name");
    await chooseSidebarSort(page, "project", "name");
    await expect.poll(() => rowTestIds(workspaceRows)).toEqual([siblingId, firstId]);
    await expect.poll(() => rowTestIds(projectRows)).toEqual([otherProjectId, firstProjectId]);
    await attemptBlockedDrag(workspaceRows);
    await attemptBlockedDrag(projectRows);
    await openWorkspaceSettings(page);
    await expectRunningFirstSetting(page, "workspace", {
      enabled: false,
      statusText: "Current sorting: Name",
    });
    await expectRunningFirstSetting(page, "project", {
      enabled: false,
      statusText: "Current sorting: Name",
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await chooseSidebarSort(page, "workspace", "recent");
    await openWorkspaceSettings(page);
    await expectRunningFirstSetting(page, "workspace", { enabled: true });
    await expectRunningFirstSetting(page, "project", { enabled: false });
    await setRunningFirst(page, "workspace", true);
    await page.reload();
    await expectRunningFirstSetting(page, "workspace", { checked: true });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await chooseSidebarSort(page, "project", "recent");
    await openWorkspaceSettings(page);
    await expectRunningFirstSetting(page, "project", { enabled: true, checked: false });
    await setRunningFirst(page, "project", true);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await quickDragFirstRowAfterSecond(projectRows, pressProjectRow);
    await openWorkspaceSettings(page);
    await expectRunningFirstSetting(page, "project", {
      enabled: false,
      statusText: "Current sorting: Manual",
    });
    await expectRunningFirstSetting(page, "workspace", { enabled: true });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await chooseSidebarSort(page, "project", "recent");
    await quickDragFirstRowAfterSecond(workspaceRows, pressWorkspaceRow);
    await openWorkspaceSettings(page);
    await expectRunningFirstSetting(page, "workspace", { enabled: false, checked: true });
    await expectRunningFirstSetting(page, "project", { enabled: true });
  } finally {
    await first.cleanup();
    await other.cleanup();
  }
});

test("running-first drops finished agents while start-based order survives output and reload", async ({
  page,
}) => {
  const running = await seedMockAgentWorkspace({
    repoPrefix: "sort-running-",
    title: "Long running",
    model: "one-minute-stream",
  });
  const latest = await seedMockAgentWorkspace({
    repoPrefix: "sort-latest-",
    title: "Latest start",
  });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await chooseSidebarSort(page, "workspace", "recent");
    await chooseSidebarSort(page, "project", "recent");
    await openWorkspaceSettings(page);
    await setRunningFirst(page, "project", true);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const oldId = `sidebar-workspace-row-${getServerId()}:${running.workspaceId}`;
    const latestId = `sidebar-workspace-row-${getServerId()}:${latest.workspaceId}`;
    const rows = page.locator(`[data-testid="${oldId}"], [data-testid="${latestId}"]`);
    await running.client.sendAgentMessage(running.agentId, "Reply with hello.");
    await running.client.waitForAgentUpsert(
      running.agentId,
      (snapshot) => snapshot.status === "running",
      15000,
    );
    await latest.client.sendAgentMessage(latest.agentId, "Reply with hello.");
    await expect.poll(() => rowTestIds(rows)).toEqual([latestId, oldId]);
    await latest.client.waitForAgentUpsert(
      latest.agentId,
      (snapshot) => snapshot.status === "idle",
      15000,
    );
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, latestId]);
    await openWorkspaceSettings(page);
    await setRunningFirst(page, "project", false);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([latestId, oldId]);
    await page.reload();
    await waitForSidebarHydration(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([latestId, oldId]);
  } finally {
    await running.cleanup();
    await latest.cleanup();
  }
});

test("status sorting supports manual drag, hydrated pinned names, collapse, and grouping roundtrips", async ({
  page,
}) => {
  const first = await seedWorkspace({ repoPrefix: "status-sort-first-", title: "Workspace 10" });
  const second = await seedWorkspace({ repoPrefix: "status-sort-second-", title: "Workspace 2" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await chooseSidebarSort(page, "project", "recent");
    await selectSidebarStatusGrouping(page);
    const firstId = `sidebar-workspace-row-${getServerId()}:${first.workspaceId}`;
    const secondId = `sidebar-workspace-row-${getServerId()}:${second.workspaceId}`;
    const done = page.getByTestId("sidebar-status-group-rows-done");
    const rows = done.locator(`[data-testid="${firstId}"], [data-testid="${secondId}"]`);
    await chooseSidebarSort(page, "workspace", "name");
    await expect.poll(() => rowTestIds(rows)).toEqual([secondId, firstId]);
    await attemptBlockedDrag(rows);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-project-sorting")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(page.getByTestId("sidebar-display-project-sorting")).toContainText(
      "Project grouping only",
    );
    await page.keyboard.press("Escape");
    await chooseSidebarSort(page, "workspace", "recent");
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    const manualOrder = await rowTestIds(rows);
    await page.reload();
    await page.locator('[data-testid^="sidebar-status-group-"]').first().waitFor();
    await expect.poll(() => rowTestIds(rows)).toEqual(manualOrder);
    await openWorkspaceSettings(page);
    await expectRunningFirstSetting(page, "workspace", { enabled: false });
    await expectRunningFirstSetting(page, "project", {
      enabled: false,
      statusText: "Group by Project",
    });
    await gotoAppShell(page);
    await page.locator('[data-testid^="sidebar-status-group-"]').first().waitFor();
    await first.client.setWorkspacePinned(first.workspaceId, true);
    await second.client.setWorkspacePinned(second.workspaceId, true);
    await chooseSidebarSort(page, "workspace", "name");
    const pinned = page
      .getByTestId("sidebar-pinned-section")
      .locator(`[data-testid="${firstId}"], [data-testid="${secondId}"]`);
    await expect.poll(() => rowTestIds(pinned)).toEqual([secondId, firstId]);
    await attemptBlockedDrag(pinned);
    await chooseSidebarSort(page, "workspace", "recent");
    await quickDragFirstRowAfterSecond(pinned, pressWorkspaceRow);
    await first.client.setWorkspacePinned(first.workspaceId, false);
    await second.client.setWorkspacePinned(second.workspaceId, false);
    await expect.poll(() => rowTestIds(rows)).toEqual(manualOrder);
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-project").click();
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-project-sorting")).toContainText(
      "Recent activity",
    );
    await page.keyboard.press("Escape");
    await selectSidebarStatusGrouping(page);
    await expect.poll(() => rowTestIds(rows)).toEqual(manualOrder);
    await page.getByTestId("sidebar-status-group-done").click();
    await expect(done).toHaveCount(0);
    await page.reload();
    await page.locator('[data-testid^="sidebar-status-group-"]').first().waitFor();
    await expect(done).toHaveCount(0);
    await page.getByTestId("sidebar-status-group-done").click();
    await expect.poll(() => rowTestIds(rows)).toEqual(manualOrder);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("status sorting preserves bucket priority and last-start order through completion", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const older = await seedMockAgentWorkspace({
    repoPrefix: "status-start-older-",
    title: "Older start",
    model: "one-minute-stream",
  });
  const latest = await seedMockAgentWorkspace({
    repoPrefix: "status-start-latest-",
    title: "Latest start",
  });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectSidebarStatusGrouping(page);
    await chooseSidebarSort(page, "workspace", "recent");
    await openWorkspaceSettings(page);
    await setRunningFirst(page, "workspace", true);
    await gotoAppShell(page);
    await page.locator('[data-testid^="sidebar-status-group-"]').first().waitFor();
    await older.client.sendAgentMessage(older.agentId, "Reply with hello.");
    await older.client.waitForAgentUpsert(older.agentId, (a) => a.status === "running", 15_000);
    await latest.client.sendAgentMessage(latest.agentId, "Reply with hello.");
    await latest.client.waitForAgentUpsert(latest.agentId, (a) => a.status === "idle", 15_000);
    await latest.client.clearWorkspaceAttention(latest.workspaceId);
    const olderId = `sidebar-workspace-row-${getServerId()}:${older.workspaceId}`;
    const latestId = `sidebar-workspace-row-${getServerId()}:${latest.workspaceId}`;
    const rows = page.locator(`[data-testid="${olderId}"], [data-testid="${latestId}"]`);
    await expect(
      page.getByTestId("sidebar-status-group-rows-running").getByTestId(olderId),
    ).toBeVisible();
    await expect(
      page.getByTestId("sidebar-status-group-rows-done").getByTestId(latestId),
    ).toBeVisible();
    await expect.poll(() => rowTestIds(rows)).toEqual([olderId, latestId]);
    await older.client.waitForAgentUpsert(older.agentId, (a) => a.status === "idle", 90_000);
    await older.client.clearWorkspaceAttention(older.workspaceId);
    await expect(page.getByTestId("sidebar-status-group-rows-running")).toHaveCount(0);
    await expect.poll(() => rowTestIds(rows)).toEqual([latestId, olderId]);
    await openWorkspaceSettings(page);
    await setRunningFirst(page, "workspace", false);
    await gotoAppShell(page);
    await page.locator('[data-testid^="sidebar-status-group-"]').first().waitFor();
    await expect.poll(() => rowTestIds(rows)).toEqual([latestId, olderId]);
    await page.reload();
    await page.locator('[data-testid^="sidebar-status-group-"]').first().waitFor();
    await expect.poll(() => rowTestIds(rows)).toEqual([latestId, olderId]);
  } finally {
    await older.cleanup();
    await latest.cleanup();
  }
});

async function attemptBlockedDrag(rows: Locator) {
  const before = await rowTestIds(rows);
  const source = await visibleBoundingBox(rows.nth(0));
  const target = await visibleBoundingBox(rows.nth(1));
  const page = rows.page();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => rowTestIds(rows)).toEqual(before);
}

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
