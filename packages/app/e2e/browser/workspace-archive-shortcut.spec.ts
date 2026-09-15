import { existsSync } from "node:fs";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  expectWorkspaceAbsentFromSidebar,
  selectWorkspaceInSidebar,
} from "../support/helpers/sidebar";
import { createMockIdleAgent, fetchAgentArchivedAt } from "../support/helpers/archive-tab";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { expectAgentTabActive } from "../support/helpers/launcher";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.describe("Workspace archive shortcut", () => {
  test("archives the selected workspace without removing its local checkout", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+Shift+Backspace`);

      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      expect(existsSync(workspace.repoPath)).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });
});

test("repeated archive shortcuts select adjacent workspaces in sidebar order", async ({ page }) => {
  const workspaces: SeededWorkspace[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      workspaces.push(await seedWorkspace({ repoPrefix: `archive-next-${index}-` }));
    }
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const rows = page.locator('[data-testid^="sidebar-workspace-row-"]');
    await expect(rows).toHaveCount(3);
    const rowIds = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid")),
    );
    const ordered = rowIds.map((rowId) => {
      const workspace = workspaces.find((item) => rowId?.endsWith(`:${item.workspaceId}`));
      if (!workspace) throw new Error(`Unknown sidebar row: ${rowId}`);
      return workspace;
    });
    const [first, second, third] = ordered;
    if (!first || !second || !third) throw new Error("Expected three workspace rows");
    await selectWorkspaceInSidebar(page, second.workspaceId);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    await page.keyboard.press(`${modifier}+Shift+Backspace`);
    await expectWorkspaceAbsentFromSidebar(page, second.workspaceId);
    await expect(page).toHaveURL(new RegExp(`/workspace/${third.workspaceId}$`));

    await page.keyboard.press(`${modifier}+Shift+Backspace`);
    await expectWorkspaceAbsentFromSidebar(page, third.workspaceId);
    await expect(page).toHaveURL(new RegExp(`/workspace/${first.workspaceId}$`));

    await page.keyboard.press(`${modifier}+Shift+Backspace`);
    await expectWorkspaceAbsentFromSidebar(page, first.workspaceId);
    await expect(page).toHaveURL(/\/new\?/);
    for (const workspace of workspaces) expect(existsSync(workspace.repoPath)).toBe(true);
  } finally {
    for (const workspace of workspaces) await workspace.cleanup();
  }
});

test("archiving one conversation opens the next conversation in the same project", async ({
  page,
}) => {
  const workspace = await seedWorkspace({
    repoPrefix: "archive-conversations-",
    title: "Conversation A",
  });
  try {
    await workspace.client.renameProject(workspace.projectId, "Archive demo");
    const created = await workspace.client.createWorkspace({
      source: { kind: "directory", path: workspace.repoPath, projectId: workspace.projectId },
      title: "Conversation B",
    });
    if (!created.workspace) throw new Error(created.error ?? "Failed to create second workspace");
    expect(created.workspace.projectId).toBe(workspace.projectId);
    const first = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Conversation A",
    });
    const second = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: created.workspace.id,
      title: "Conversation B",
    });
    const agents = [first, second];
    for (const agent of agents) {
      await workspace.client.sendAgentMessage(
        agent.id,
        `${agent.title}: keep this existing conversation visible.`,
      );
      await workspace.client.waitForFinish(agent.id, 15_000);
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.id });
      await expectAgentTabActive(page, agent.id);
    }
    await waitForSidebarHydration(page);
    await expect(page.locator('[data-testid^="sidebar-project-row-"]')).toHaveCount(1);
    const rows = page.locator('[data-testid^="sidebar-workspace-row-"]');
    await expect(rows).toHaveCount(2);
    const firstRowId = await rows.first().getAttribute("data-testid");
    const current = agents.find((agent) => firstRowId?.endsWith(`:${agent.workspaceId}`));
    const next = agents.find((agent) => agent.id !== current?.id);
    if (!current || !next) throw new Error("Expected two conversations in sidebar order");
    await selectWorkspaceInSidebar(page, current.workspaceId);
    await expectAgentTabActive(page, current.id);
    await expect(
      page.getByText(`${current.title}: keep this existing conversation visible.`, { exact: true }),
    ).toBeVisible();

    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+Shift+Backspace`);

    await expectWorkspaceAbsentFromSidebar(page, current.workspaceId);
    await expect(page).toHaveURL(new RegExp(`/workspace/${next.workspaceId}$`));
    await expectAgentTabActive(page, next.id);
    await expect(
      page.getByText(`${next.title}: keep this existing conversation visible.`, { exact: true }),
    ).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect.poll(() => fetchAgentArchivedAt(workspace.client, current.id)).not.toBeNull();
    expect(await fetchAgentArchivedAt(workspace.client, next.id)).toBeNull();
    expect(existsSync(workspace.repoPath)).toBe(true);
  } finally {
    await workspace.cleanup();
  }
});
