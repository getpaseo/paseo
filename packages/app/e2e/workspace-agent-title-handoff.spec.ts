import { test, expect } from "./fixtures";
import { expectComposerVisible, submitMessage } from "./helpers/composer";
import { delayBrowserAgentCreatedStatus } from "./helpers/new-workspace";
import { seedWorkspace, type SeedDaemonClient } from "./helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import { getServerId } from "./helpers/server-id";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

async function waitForCreatedAgentId(
  client: SeedDaemonClient,
  input: { cwd: string; workspaceId: string },
): Promise<string> {
  await expect
    .poll(
      async () => {
        const result = await client.fetchAgents({ scope: "active" });
        return result.entries
          .filter(
            (entry) =>
              entry.agent.cwd === input.cwd && entry.agent.workspaceId === input.workspaceId,
          )
          .map((entry) => entry.agent.id);
      },
      { timeout: 30_000 },
    )
    .toHaveLength(1);
  const result = await client.fetchAgents({ scope: "active" });
  const agent = result.entries.find(
    (entry) => entry.agent.cwd === input.cwd && entry.agent.workspaceId === input.workspaceId,
  );
  if (!agent) {
    throw new Error(`Expected one created agent in ${input.cwd}`);
  }
  return agent.agent.id;
}

async function fetchActiveAgentTitle(
  client: SeedDaemonClient,
  agentId: string,
): Promise<string | null> {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
}

test.describe("Workspace agent title handoff", () => {
  test("shows the prompt tab title and replaces it when the daemon title updates", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    const agentCreatedDelay = await delayBrowserAgentCreatedStatus(page);
    const workspace = await seedWorkspace({ repoPrefix: "workspace-title-handoff-" });

    try {
      await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      await waitForWorkspaceTabsVisible(page);
      await page.getByTestId("workspace-new-agent-tab-inline").click();
      await expectComposerVisible(page);

      const promptTitle = "Investigate optimistic tab title handoff";
      const generatedTitle = "Generated Handoff Title";
      await submitMessage(page, `${promptTitle}\n\nMake the UI state deterministic.`);
      await agentCreatedDelay.waitForCreateRequest();
      await agentCreatedDelay.waitForDelayedCreatedStatus();

      await expect(page.getByRole("button", { name: promptTitle }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText(/Loading agent title|Loading\.\.\./).filter({ visible: true }),
      ).toHaveCount(0);

      const agentId = await waitForCreatedAgentId(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
      });

      await expect(page.getByTestId(`workspace-tab-agent_${agentId}`)).toHaveCount(0);
      agentCreatedDelay.release();

      const agentTab = page.getByTestId(`workspace-tab-agent_${agentId}`).first();
      await expect(agentTab).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => fetchActiveAgentTitle(workspace.client, agentId), { timeout: 10_000 })
        .toBe(promptTitle);
      await expect(agentTab).toContainText(promptTitle, { timeout: 15_000 });
      await agentTab.click({ button: "right" });
      await expect(page.getByTestId(`workspace-tab-context-agent_${agentId}-rename`)).toBeVisible({
        timeout: 10_000,
      });
      await page.keyboard.press("Escape");
      await expect(
        page.getByText(/Loading agent title|Loading\.\.\./).filter({ visible: true }),
      ).toHaveCount(0);

      await workspace.client.updateAgent(agentId, { name: generatedTitle });
      await expect
        .poll(() => fetchActiveAgentTitle(workspace.client, agentId), { timeout: 10_000 })
        .toBe(generatedTitle);
      await expect(page.getByRole("button", { name: generatedTitle }).first()).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      agentCreatedDelay.release();
      await workspace.cleanup();
    }
  });
});
