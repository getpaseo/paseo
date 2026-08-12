import { test } from "../support/fixtures";
import { closeCommandCenter, openCommandCenter } from "../support/helpers/command-center";
import {
  applyCommandCenterAgentControls,
  chooseCommandCenterAgentControl,
  expectCommandCenterAgentControlRowCount,
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
  expectNewWorkspaceProjectSelected,
  openGlobalNewWorkspaceComposer,
  selectWorkspaceIsolation,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";

async function seedMockDraftPreferences(
  page: import("@playwright/test").Page,
  options?: { mode?: string },
): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey, serverId, mode }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          serverId,
          provider: "mock",
          providerPreferences: {
            mock: {
              model: "five-minute-stream",
              mode,
            },
          },
        }),
      );
    },
    {
      preferencesKey: CREATE_AGENT_PREFERENCES_KEY,
      serverId: getServerId(),
      mode: options?.mode ?? "load-test",
    },
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

  test("applies New workspace choices to the created agent", async ({ page }) => {
    const serverId = getServerId();
    const seeded = await seedWorkspace({ repoPrefix: "command-center-new-workspace-controls-" });
    // A non-default seeded mode makes the Mode row a real change rather than a selected-row no-op.
    await seedMockDraftPreferences(page, { mode: "approval-test" });
    const client = await connectNewWorkspaceDaemonClient();

    try {
      await gotoWorkspace(page, seeded.workspaceId);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, seeded.projectDisplayName);
      await selectWorkspaceIsolation(page, "local");

      await applyCommandCenterAgentControls(page, DRAFT_AGENT_CONTROL_CHOICES);

      // The seeded workspace is still mounted behind /new. Exactly one owner may publish the row.
      await openCommandCenter(page);
      await expectCommandCenterAgentControlRowCount({
        page,
        query: "load test",
        choice: "Mode › Load test",
        count: 1,
      });
      await closeCommandCenter(page);

      await submitNewWorkspacePrompt(page, "Create with Command Center choices");
      const created = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: seeded.workspaceId,
        projectDisplayName: seeded.projectDisplayName,
      });

      // Must be the CREATED workspace: expectWorkspaceAgentConfiguration filters by the id it is
      // handed, so passing the seeded one would assert against the wrong agent.
      await expectWorkspaceAgentConfiguration(
        { client: seeded.client, workspaceId: created.workspaceId },
        { provider: "mock", model: "ten-second-stream", modeId: "load-test" },
      );
    } finally {
      await client.close().catch(() => undefined);
      await seeded.cleanup();
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
