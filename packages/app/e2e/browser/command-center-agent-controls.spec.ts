import { expect, test } from "../support/fixtures";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import {
  closeCommandCenter,
  openCommandCenter,
  openCommandCenterWithShortcut,
} from "../support/helpers/command-center";
import {
  enterComposerFullscreen,
  exitComposerFullscreen,
  expectComposerVisible,
  fillComposerDraft,
  resizeComposerViewport,
} from "../support/helpers/composer";
import {
  applyCommandCenterAgentControls,
  chooseCommandCenterAgentControl,
  openCommandCenterForAgent,
  searchAgentControls,
  expectCommandCenterAgentControlSelected,
  expectFocusedAgentControls,
  expectWorkspaceAgentConfiguration,
  submitDraftAgent,
  waitForDraftComposer,
} from "../support/helpers/command-center-agent-controls";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  selectWorkspaceIsolation,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { seedWorkspace } from "../support/helpers/seed-client";
import { closeMobileAgentSidebar, openMobileAgentSidebar } from "../support/helpers/sidebar";
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
              mode: "approval-test",
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
      await openCommandCenterForAgent(page, workspace);
      await searchAgentControls(page, "load");
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
      await searchAgentControls(page, "loa");
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

  test("applies New workspace model and mode choices before the first message", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "command-center-new-workspace-controls-" });
    await seedMockDraftPreferences(page);
    const client = await connectNewWorkspaceDaemonClient();

    try {
      const backgroundAgent = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Background agent",
        model: "five-minute-stream",
        modeId: "approval-test",
      });
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: backgroundAgent.id,
      });
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, workspace);
      await selectWorkspaceIsolation(page, "local");

      await applyCommandCenterAgentControls(page, DRAFT_AGENT_CONTROL_CHOICES);
      await closeCommandCenter(page);
      await submitNewWorkspacePrompt(page, "Create with Command Center choices");
      const created = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: workspace.workspaceId,
        projectDisplayName: workspace.projectDisplayName,
      });

      await expectWorkspaceAgentConfiguration(
        { client: workspace.client, workspaceId: created.workspaceId },
        { provider: "mock", model: "ten-second-stream", modeId: "load-test" },
      );
      await expectWorkspaceAgentConfiguration(workspace, {
        id: backgroundAgent.id,
        provider: "mock",
        model: "five-minute-stream",
        modeId: "approval-test",
      });
    } finally {
      await client.close().catch(() => undefined);
      await workspace.cleanup();
    }
  });

  test("keeps draft settings searchable from the compact sidebar and fullscreen editor", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "command-center-fullscreen-draft-" });
    await seedMockDraftPreferences(page);

    try {
      await openDraftComposer(page, workspace.workspaceId);
      await resizeComposerViewport(page, "portrait");
      await applyCompactComposerSettings(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("applies compact sidebar and fullscreen settings to the running agent", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "command-center-fullscreen-agent-",
      title: "Compact Command Center settings",
      model: "five-minute-stream",
      modeId: "approval-test",
    });

    try {
      await resizeComposerViewport(page, "portrait");
      await openAgentRoute(page, workspace);
      await applyCompactComposerSettings(page);
      await expectWorkspaceAgentConfiguration(workspace, {
        id: workspace.agentId,
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

async function applyCompactComposerSettings(page: import("@playwright/test").Page): Promise<void> {
  const [model, mode] = DRAFT_AGENT_CONTROL_CHOICES;
  await expectComposerVisible(page);
  await openMobileAgentSidebar(page);
  await openCommandCenter(page);
  await chooseCommandCenterAgentControl({ page, ...mode });
  await closeMobileAgentSidebar(page);

  await fillComposerDraft(page, "First line\nSecond line\nThird line");
  await enterComposerFullscreen(page);
  await openCommandCenterWithShortcut(page);
  await chooseCommandCenterAgentControl({ page, ...model });
  await exitComposerFullscreen(page);

  await openCommandCenterWithShortcut(page);
  await expectCommandCenterAgentControlSelected({ page, ...model });
  await expectCommandCenterAgentControlSelected({ page, ...mode });
}
