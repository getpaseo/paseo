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
import { expectAppRoute } from "../support/helpers/route-assertions";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildSchedulesRoute } from "@/utils/host-routes";

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

  test("search, select, and re-rank live agent controls before navigating to an action", async ({
    page,
  }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "command-center-live-controls-",
      title: "Command Center live controls",
      model: "five-minute-stream",
    });
    try {
      await workspace.client.setAgentMode(workspace.agentId, "legacy-mode");
      await openAgentRoute(page, workspace);
      await test.step("changes a running agent setting and preserves its selected row", async () => {
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

        await closeCommandCenter(page);
      });
      await test.step("matches query tokens in any order", async () => {
        await workspace.client.setAgentMode(workspace.agentId, "legacy-mode");
        await openCommandCenter(page);
        await chooseCommandCenterAgentControl({
          page,
          query: "test load",
          choice: "Mode › Load test",
        });

        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: "mock",
          model: "five-minute-stream",
          modeId: "load-test",
        });
      });
      await test.step("activates the best-matching row, not the highest-ranked group", async () => {
        await workspace.client.setAgentMode(workspace.agentId, "approval-test");
        const panel = await openCommandCenter(page);
        const input = panel.getByTestId("command-center-input");
        await input.fill("load");
        await page.keyboard.press("Enter");

        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: "mock",
          model: "five-minute-stream",
          modeId: "load-test",
        });
      });
      await test.step("drops an arrow-key selection once the query changes", async () => {
        await workspace.client.setAgentMode(workspace.agentId, "approval-test");
        const panel = await openCommandCenter(page);
        const input = panel.getByTestId("command-center-input");
        await input.fill("loa");
        // Moves the highlight onto a model row, which still matches after the next keystroke.
        await page.keyboard.press("ArrowDown");
        await input.fill("load");
        await page.keyboard.press("Enter");

        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: "mock",
          model: "five-minute-stream",
          modeId: "load-test",
        });
      });
      await test.step("keeps an action first when the action is the best match", async () => {
        const panel = await openCommandCenter(page);
        const input = panel.getByTestId("command-center-input");
        await input.fill("sched");
        await page.keyboard.press("Enter");

        await expectAppRoute(page, buildSchedulesRoute(), { timeout: 30_000 });
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
