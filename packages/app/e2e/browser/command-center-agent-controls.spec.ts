import { expect, test } from "../support/fixtures";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { closeCommandCenter, openCommandCenter } from "../support/helpers/command-center";
import {
  applyCommandCenterAgentControls,
  chooseCommandCenterAgentControl,
  expectCommandCenterAgentControlSelected,
  expectFocusedAgentControls,
  expectWorkspaceAgentConfiguration,
  submitDraftAgent,
  waitForDraftComposer,
} from "../support/helpers/command-center-agent-controls";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";

async function seedMockDraftPreferences(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          provider: "mock",
          providerPreferences: {
            mock: {
              model: "five-minute-stream",
              mode: "load-test",
            },
          },
        } satisfies FormPreferences),
      );
    },
    { preferencesKey: CREATE_AGENT_PREFERENCES_KEY },
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
      await openCommandCenter(page);
      await chooseCommandCenterAgentControl({
        page,
        query: "load test",
        choice: "Mode › Load test",
      });
      await expectWorkspaceAgentConfiguration(workspace, {
        id: workspace.agentId,
        provider: "mock",
        model: "five-minute-stream",
        modeId: "load-test",
      });
      await openCommandCenter(page);
      await expectCommandCenterAgentControlSelected({
        page,
        query: "load test",
        choice: "Mode › Load test",
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("shows an existing agent's only supported thinking level", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-controls-single-thinking-",
      title: "Single thinking level",
      model: "max-only-thinking-stream",
      thinkingOptionId: "max",
    });
    try {
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      await expect(
        page.getByTestId("agent-thinking-selector").filter({ visible: true }),
      ).toHaveAccessibleName("Select thinking option (Max)");
    } finally {
      await workspace.cleanup();
    }
  });

  test("applies draft model and setting choices to the created agent", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "command-center-draft-controls-" });
    await seedMockDraftPreferences(page);

    try {
      await openDraftComposer(page, workspace.workspaceId);
      await applyCommandCenterAgentControls(page, DRAFT_AGENT_CONTROL_CHOICES);
      await closeCommandCenter(page);
      await submitDraftAgent(page, "Create an agent with Command Center draft choices");
      await expectFocusedAgentControls(page, DRAFT_AGENT_CONTROL_CHOICES);
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "ten-second-stream",
        modeId: "load-test",
      });
    } finally {
      await workspace.cleanup();
    }
  });
});

const DRAFT_AGENT_CONTROL_CHOICES = [
  { query: "ten second stream", choice: "Model › Mock Load Test › Ten second stream" },
  { query: "load test", choice: "Mode › Load test" },
] as const;

async function openDraftComposer(page: import("@playwright/test").Page, workspaceId: string) {
  await gotoWorkspace(page, workspaceId);
  await clickNewChat(page);
  await waitForDraftComposer(page);
}
