import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "./fixtures";
import { seedWorkspace } from "./helpers/seed-client";
import { createIdleAgent, expectWorkspaceTabVisible } from "./helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { captureWsSessionFrames, renameModalInput, renameModalSubmit } from "./helpers/rename";
import { getServerId } from "./helpers/server-id";

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
  test("right-click rename sends update_agent_request and updates the tab label", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-agent-rename-" });

    try {
      const initialTitle = `agent-rename-${randomUUID().slice(0, 8)}`;
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        title: initialTitle,
      });

      const updateFrames = captureWsSessionFrames(page, "update_agent_request", (inner) => ({
        agentId: String(inner.agentId ?? ""),
        name: String(inner.name ?? ""),
        requestId: String(inner.requestId ?? ""),
      }));

      await openAgentInWorkspace(page, agent);

      const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`).first();
      await expect(tab).toContainText(initialTitle, { timeout: 15_000 });

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
      await expect(tab).toContainText(renamed, { timeout: 15_000 });

      expect(updateFrames.length).toBeGreaterThan(0);
      const lastFrame = updateFrames.at(-1)!;
      expect(lastFrame.agentId).toBe(agent.id);
      expect(lastFrame.name).toBe(renamed);
      expect(lastFrame.requestId.length).toBeGreaterThan(0);
    } finally {
      await workspace.cleanup();
    }
  });
});
