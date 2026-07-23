import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { openCommandCenter } from "./helpers/command-center";
import { clickNewChat, gotoWorkspace } from "./helpers/launcher";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";

async function readWorkspaceAgentConfig(
  workspace: Pick<SeededWorkspace, "client" | "workspaceId">,
  agentId?: string,
): Promise<{
  id: string;
  provider: string;
  model: string | null;
  modeId: string | null;
} | null> {
  const entries = (await workspace.client.fetchAgents({ scope: "active" })).entries;
  const agent = entries
    .map((entry) => entry.agent)
    .find(
      (candidate) =>
        candidate.workspaceId === workspace.workspaceId && (!agentId || candidate.id === agentId),
    );
  if (!agent) return null;
  return {
    id: agent.id,
    provider: agent.provider,
    model: agent.model,
    modeId: agent.currentModeId,
  };
}

async function seedMockDraftPreferences(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey, serverId }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          serverId,
          provider: "mock",
          providerPreferences: {
            mock: {
              model: "five-minute-stream",
              mode: "load-test",
            },
          },
        }),
      );
    },
    { preferencesKey: CREATE_AGENT_PREFERENCES_KEY, serverId: getServerId() },
  );
}

test.describe("Command Center agent controls", () => {
  test.describe.configure({ timeout: 180_000 });

  test("changes a running agent setting and preserves its selected row", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "command-center-live-controls-",
      title: "Command Center live controls",
      model: "five-minute-stream",
    });
    try {
      // A stale runtime mode makes selecting the provider's supported mode
      // exercise the live setting RPC instead of the selected-row no-op.
      await workspace.client.setAgentMode(workspace.agentId, "legacy-mode");
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("load test");
      const loadTestMode = panel.getByTestId(
        `command-center-mode-${getServerId()}:${workspace.agentId}:load-test`,
      );
      await expect(loadTestMode).toBeVisible({ timeout: 30_000 });
      await loadTestMode.click();

      await expect
        .poll(() => readWorkspaceAgentConfig(workspace, workspace.agentId), { timeout: 30_000 })
        .toMatchObject({ id: workspace.agentId, modeId: "load-test" });

      const reopened = await openCommandCenter(page);
      await reopened.getByTestId("command-center-input").fill("load test");
      await expect(
        reopened.getByTestId(`command-center-mode-${getServerId()}:${workspace.agentId}:load-test`),
      ).toHaveAttribute("aria-selected", "true");
    } finally {
      await workspace.cleanup();
    }
  });

  test("applies draft model and setting choices to the created agent", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "command-center-draft-controls-" });
    await seedMockDraftPreferences(page);

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewChat(page);

      const modelPanel = await openCommandCenter(page);
      await modelPanel.getByTestId("command-center-input").fill("ten second stream");
      const modelRow = modelPanel.getByTestId(
        `command-center-model-${getServerId()}:mock:ten-second-stream`,
      );
      await expect(modelRow).toBeVisible({ timeout: 30_000 });
      await modelRow.click();

      const settingPanel = await openCommandCenter(page);
      await settingPanel.getByTestId("command-center-input").fill("load test");
      const loadTestMode = settingPanel
        .locator(`[data-testid^="command-center-mode-${getServerId()}:"]`)
        .first();
      await expect(loadTestMode).toBeVisible({ timeout: 30_000 });
      await loadTestMode.click();

      const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
      await expect(composer).toBeEditable({ timeout: 30_000 });
      await composer.fill("Create an agent with Command Center draft choices");
      await composer.press("Enter");
      await expect(page.locator('[data-testid^="workspace-tab-agent_"]').first()).toBeVisible({
        timeout: 30_000,
      });

      await expect
        .poll(() => readWorkspaceAgentConfig(workspace), { timeout: 30_000 })
        .toMatchObject({
          provider: "mock",
          model: "ten-second-stream",
          modeId: "load-test",
        });
    } finally {
      await workspace.cleanup();
    }
  });
});
