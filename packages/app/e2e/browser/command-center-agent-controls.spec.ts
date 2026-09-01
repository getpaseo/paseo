import { test } from "../support/fixtures";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { closeCommandCenter, openCommandCenter } from "../support/helpers/command-center";
import {
  applyCommandCenterAgentControls,
  chooseCommandCenterAgentControl,
  openCommandCenterForAgent,
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

  test("activates the best-matching row, not the highest-ranked group", async ({ page }) => {
    // "Mode › Load Test" matches "load" at offset 0; every "Model › Mock Load Test › …" row
    // matches at offset 5. Models used to outrank modes by fixed group rank, so Enter picked a
    // model. Asserting both model and mode catches either row winning.
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "command-center-relevance-",
      title: "Command Center relevance",
      model: "five-minute-stream",
    });
    try {
      await workspace.client.setAgentMode(workspace.agentId, "approval-test");
      const input = await openCommandCenterForAgent(page, workspace);
      await input.fill("load");
      await page.keyboard.press("Enter");

      await expectWorkspaceAgentConfiguration(workspace, {
        id: workspace.agentId,
        provider: "mock",
        model: "five-minute-stream",
        modeId: "load-test",
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("matches query tokens in any order", async ({ page }) => {
    // "Mode › Load test" flattens to "mode load test", so the reversed query "test load" is never
    // a substring of it. Only per-token matching finds this row.
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "command-center-tokenized-",
      title: "Command Center tokenized search",
      model: "five-minute-stream",
    });
    try {
      await workspace.client.setAgentMode(workspace.agentId, "legacy-mode");
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });
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
    } finally {
      await workspace.cleanup();
    }
  });

  test("keeps an action first when the action is the best match", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "command-center-action-priority-",
      title: "Command Center action priority",
      model: "five-minute-stream",
    });
    try {
      const input = await openCommandCenterForAgent(page, workspace);
      await input.fill("sched");
      await page.keyboard.press("Enter");

      await expectAppRoute(page, buildSchedulesRoute(), { timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });

  test("drops an arrow-key selection once the query changes", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "command-center-active-reset-",
      title: "Command Center active reset",
      model: "five-minute-stream",
    });
    try {
      await workspace.client.setAgentMode(workspace.agentId, "approval-test");
      const input = await openCommandCenterForAgent(page, workspace);
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
