import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
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

async function dragWithoutReordering(rows: Locator): Promise<void> {
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

test("projects and pinned chats reorder while ordinary workspaces stay newest first", async ({
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
    const ordinaryRows = page.locator(
      `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
    );
    await expect
      .poll(() => rowTestIds(ordinaryRows))
      .toEqual([secondWorkspaceTestId, firstWorkspaceTestId]);
    await dragWithoutReordering(ordinaryRows);

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

async function selectWorkspaceSort(page: Page, name: "Manual" | "Created" | "Last prompt") {
  await page.getByLabel("Display preferences", { exact: true }).click();
  await page.getByRole("menuitem", { name: /^Sort/ }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

async function reconnectSidebar(page: Page): Promise<void> {
  await page.reload();
  await waitForSidebarHydration(page);
}

async function expectNoWorkspaceSortChoice(page: Page): Promise<void> {
  await page.getByLabel("Display preferences", { exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Sort/ })).toHaveCount(0);
}

async function promptWorkspace(seed: Awaited<ReturnType<typeof seedWorkspace>>, agentId: string) {
  await seed.client.sendAgentMessage(agentId, "sidebar ordering check");
  expect((await seed.client.waitForFinish(agentId, 30_000)).status).toBe("idle");
}

test("Created stays stable, Last prompt follows human submissions and survives tab archive", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seed = await seedWorkspace({ repoPrefix: "sidebar-sort-" });
  try {
    const newer = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "Newer workspace",
    });
    if (!newer.workspace) throw new Error(newer.error ?? "Workspace creation failed");
    const agent = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: seed.workspaceId,
      modeId: "load-test",
      model: "e2e-fast-stream",
      title: "Ordering agent",
    });
    const newerAgent = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: newer.workspace.id,
      modeId: "load-test",
      model: "e2e-fast-stream",
      title: "Newer agent",
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const oldId = `sidebar-workspace-row-${getServerId()}:${seed.workspaceId}`;
    const newId = `sidebar-workspace-row-${getServerId()}:${newer.workspace.id}`;
    const rows = page.locator(`[data-testid="${oldId}"], [data-testid="${newId}"]`);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await promptWorkspace(seed, agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await selectWorkspaceSort(page, "Last prompt");
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await promptWorkspace(seed, newerAgent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await promptWorkspace(seed, agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await seed.client.archiveAgent(agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await reconnectSidebar(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await selectWorkspaceSort(page, "Created");
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await selectSidebarStatusGrouping(page);
    await expectNoWorkspaceSortChoice(page);
  } finally {
    await seed.cleanup();
  }
});

async function seedCompactProject() {
  const seed = await seedWorkspace({
    repoPrefix: "sidebar-visibility-",
    title: "Oldest workspace",
  });
  const ids = [seed.workspaceId];
  for (let index = 2; index <= 12; index += 1) {
    const created = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: `Workspace ${index}`,
    });
    if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
    ids.unshift(created.workspace.id);
  }
  const agent = await seed.client.createAgent({
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
    cwd: seed.repoPath,
    workspaceId: seed.workspaceId,
    title: "Overflow agent",
  });
  return { seed, ids, agent };
}

async function expectWorkspaceOrder(rows: Locator, ids: string[]) {
  await expect
    .poll(() => rowTestIds(rows))
    .toEqual(ids.map((id) => `sidebar-workspace-row-${getServerId()}:${id}`));
}

async function revealWorkspaces(list: Locator, action: "Show more" | "Show less") {
  await list.getByLabel(action, { exact: true }).click();
}

async function selectProjectGrouping(page: Page) {
  await page.getByLabel("Display preferences", { exact: true }).click();
  await page.getByRole("menuitem", { name: /^Group/ }).click();
  await page.getByTestId("sidebar-grouping-project").click();
}

type CompactProject = Awaited<ReturnType<typeof seedCompactProject>>;

function compactProjectRows(page: Page, seed: CompactProject["seed"]) {
  const list = page.getByTestId(`sidebar-workspace-list-${seed.projectKey}`);
  return {
    rows: list.locator('[data-testid^="sidebar-workspace-row-"]'),
    group: list.locator(".."),
    project: page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(seed.projectKey)}`),
  };
}

async function expectActiveOverflowTransitions(page: Page, { seed, ids, agent }: CompactProject) {
  const { rows } = compactProjectRows(page, seed);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));

  await seed.client.sendAgentMessage(agent.id, "show active overflow");
  await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[11]]);
  await seed.client.waitForFinish(agent.id, 15_000);
  await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[11]]);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

async function expectRevealSurvivesSortingAndCollapse(
  page: Page,
  { seed, ids, agent }: CompactProject,
) {
  const { rows, group, project } = compactProjectRows(page, seed);
  const retainedRows = await rows.elementHandles();
  await revealWorkspaces(group, "Show more");
  await expectWorkspaceOrder(rows, ids);
  for (const [index, retained] of retainedRows.entries()) {
    expect(
      await rows.nth(index).evaluate((current, previous) => current === previous, retained),
    ).toBe(true);
  }
  await project.click();
  await expect(rows).toHaveCount(0);
  await project.click();
  await expectWorkspaceOrder(rows, ids);
  await seed.client.sendAgentMessage(agent.id, "expanded overflow");
  await seed.client.waitForFinish(agent.id, 15_000);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expectWorkspaceOrder(rows, ids);
  await selectWorkspaceSort(page, "Last prompt");
  await expectWorkspaceOrder(rows, [ids[11], ...ids.slice(0, 11)]);
  const revealedRow = await rows.nth(8).elementHandle();
  await revealWorkspaces(group, "Show less");
  await expectWorkspaceOrder(rows, [ids[11], ...ids.slice(0, 6)]);
  await selectWorkspaceSort(page, "Created");
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
  expect(await revealedRow!.evaluate((row) => row.isConnected)).toBe(false);
  await reconnectSidebar(page);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

async function expectStatusBucketsRetainActiveOverflow(
  page: Page,
  { seed, ids, agent }: CompactProject,
) {
  const { rows } = compactProjectRows(page, seed);
  await selectSidebarStatusGrouping(page);
  const done = page.getByTestId("sidebar-status-group-rows-done");
  const doneRows = done.locator('[data-testid^="sidebar-workspace-row-"]');
  await expect(doneRows).toHaveCount(7);
  await revealWorkspaces(done, "Show more");
  await expect(doneRows).toHaveCount(12);
  await seed.client.sendAgentMessage(agent.id, "status overflow");
  await seed.client.waitForFinish(agent.id, 15_000);
  await expect(
    page
      .getByTestId("sidebar-status-group-rows-attention")
      .getByText("Oldest workspace", { exact: true }),
  ).toBeVisible();
  await expect(doneRows).toHaveCount(11);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expect(doneRows).toHaveCount(12);
  await revealWorkspaces(done, "Show less");
  await expect(doneRows).toHaveCount(7);
  const activeAgents: Array<{ id: string }> = [];
  for (const workspaceId of ids.slice(0, 8)) {
    activeAgents.push(
      await seed.client.createAgent({
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "load-test",
        cwd: seed.repoPath,
        workspaceId,
        title: "Active overflow agent",
      }),
    );
  }
  await Promise.all(
    activeAgents.map((item) => seed.client.sendAgentMessage(item.id, "active bucket")),
  );
  await Promise.all(activeAgents.map((item) => seed.client.waitForFinish(item.id, 15_000)));
  const attention = page.getByTestId("sidebar-status-group-rows-attention");
  await expect(attention.locator('[data-testid^="sidebar-workspace-row-"]')).toHaveCount(8);
  await expect(attention.getByLabel("Show more", { exact: true })).toHaveCount(0);
  for (const workspaceId of ids.slice(0, 8)) await seed.client.clearWorkspaceAttention(workspaceId);
  await expect(doneRows).toHaveCount(7);
  await selectProjectGrouping(page);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

test("compact groups retain active overflow and reveal the current ordered rows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await seedCompactProject();
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await test.step("Active overflow appears without intervening Done rows", () =>
      expectActiveOverflowTransitions(page, fixture));
    await test.step("Reveal follows current sort and survives collapse", () =>
      expectRevealSurvivesSortingAndCollapse(page, fixture));
    await test.step("Status reveals Done rows and keeps every active row", () =>
      expectStatusBucketsRetainActiveOverflow(page, fixture));
  } finally {
    await fixture.seed.cleanup();
  }
});

async function restorePreBetaOrder(page: Page, projectKey: string, workspaceKeys: string[]) {
  await page.evaluate(
    ({ projectKey: scope, workspaceKeys: order }) => {
      localStorage.setItem(
        "sidebar-project-workspace-order",
        JSON.stringify({
          version: 1,
          state: {
            projectOrder: [scope],
            pinnedWorkspaceOrder: [],
            workspaceOrderByProject: { [scope]: order },
          },
        }),
      );
    },
    { projectKey, workspaceKeys },
  );
  await reconnectSidebar(page);
}

test("Manual restores pre-beta order and keeps drag order across sorting and reloads", async ({
  page,
}) => {
  const seed = await seedWorkspace({ repoPrefix: "sidebar-manual-" });
  try {
    const second = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "New manual workspace",
    });
    if (!second.workspace) throw new Error(second.error ?? "Workspace creation failed");
    const keys = [seed.workspaceId, second.workspace.id].map((id) => `${getServerId()}:${id}`);
    const ids = keys.map((key) => `sidebar-workspace-row-${key}`);
    const rows = page.locator(ids.map((id) => `[data-testid="${id}"]`).join(", "));
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await restorePreBetaOrder(page, projectEquivalenceViewKey(seed.projectKey), keys);
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await selectWorkspaceSort(page, "Created");
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await selectWorkspaceSort(page, "Last prompt");
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await reconnectSidebar(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await selectWorkspaceSort(page, "Created");
    await reconnectSidebar(page);
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
  } finally {
    await seed.cleanup();
  }
});
