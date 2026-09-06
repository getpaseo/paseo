import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { createMockIdleAgent, expectWorkspaceTabVisible } from "../support/helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import {
  cancelWorkspaceTabInlineRename,
  expectAgentTitleOnDaemon,
  expectWorkspaceTabTitle,
  renameModalInput,
  renameModalSubmit,
  startWorkspaceTabInlineRename,
  submitWorkspaceTabInlineRename,
} from "../support/helpers/rename";
import { getServerId } from "../support/helpers/server-id";

async function openAgentInWorkspace(page: Page, agent: { id: string; workspaceId: string }) {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.workspaceId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForWorkspaceTabsVisible(page);
  await expectWorkspaceTabVisible(page, agent.id);
}

test.describe("Workspace agent tab rename", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("right-click rename persists the agent title and updates the tab label", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-agent-rename-" });
    cleanupTasks.push(() => workspace.cleanup());

    const initialTitle = `agent-rename-${randomUUID().slice(0, 8)}`;
    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: initialTitle,
    });

    await openAgentInWorkspace(page, agent);
    await expectWorkspaceTabTitle(page, "agent", agent.id, initialTitle);

    const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`).first();
    await tab.click({ button: "right" });
    await expect(page.getByTestId(`workspace-tab-context-agent_${agent.id}`)).toBeVisible({
      timeout: 10_000,
    });
    const renameItem = page.getByTestId(`workspace-tab-context-agent_${agent.id}-rename`);
    await expect(renameItem).toBeVisible({ timeout: 10_000 });
    await renameItem.click();

    const modalPrefix = `workspace-tab-rename-modal-agent-${agent.id}`;
    const input = renameModalInput(page, modalPrefix);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue(initialTitle);

    const renamed = "My Renamed Agent";
    await input.fill(renamed);
    await renameModalSubmit(page, modalPrefix).click();

    await expect(input).toHaveCount(0, { timeout: 15_000 });
    await expectWorkspaceTabTitle(page, "agent", agent.id, renamed);
    await expectAgentTitleOnDaemon(workspace.client, agent.id, renamed);
  });

  test("double-clicking an agent tab title opens inline rename and saves on enter", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-agent-inline-rename-" });
    cleanupTasks.push(() => workspace.cleanup());

    const initialTitle = `inline-agent-${randomUUID().slice(0, 8)}`;
    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: initialTitle,
    });

    await openAgentInWorkspace(page, agent);
    await expectWorkspaceTabTitle(page, "agent", agent.id, initialTitle);

    await startWorkspaceTabInlineRename(page, "agent", agent.id);
    await submitWorkspaceTabInlineRename(page, "agent", agent.id, "Inline Renamed Agent");

    await expectWorkspaceTabTitle(page, "agent", agent.id, "Inline Renamed Agent");
    await expectAgentTitleOnDaemon(workspace.client, agent.id, "Inline Renamed Agent");
  });

  test("pressing Escape cancels agent tab inline rename without saving", async ({ page }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-agent-inline-cancel-" });
    cleanupTasks.push(() => workspace.cleanup());

    const initialTitle = `inline-cancel-${randomUUID().slice(0, 8)}`;
    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: initialTitle,
    });

    await openAgentInWorkspace(page, agent);
    await expectWorkspaceTabTitle(page, "agent", agent.id, initialTitle);

    await startWorkspaceTabInlineRename(page, "agent", agent.id);
    await cancelWorkspaceTabInlineRename(page, "agent", agent.id);

    await expectWorkspaceTabTitle(page, "agent", agent.id, initialTitle);
    await expectAgentTitleOnDaemon(workspace.client, agent.id, initialTitle);
  });

  test("double-clicking a terminal tab title opens inline rename and saves on enter", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-terminal-inline-rename-" });
    cleanupTasks.push(() => workspace.cleanup());

    const initialTitle = `terminal-${randomUUID().slice(0, 8)}`;
    const result = await workspace.client.createTerminal(
      workspace.repoPath,
      initialTitle,
      undefined,
      {
        workspaceId: workspace.workspaceId,
      },
    );
    if (!result.terminal) throw new Error(`Failed to create terminal: ${result.error}`);
    const terminal = result.terminal;

    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "seed-agent",
    });

    await openAgentInWorkspace(page, agent);
    await startWorkspaceTabInlineRename(page, "terminal", terminal.id);
    await submitWorkspaceTabInlineRename(page, "terminal", terminal.id, "Renamed Terminal Tab");

    await expectWorkspaceTabTitle(page, "terminal", terminal.id, "Renamed Terminal Tab");
  });
});
