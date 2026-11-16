import { test, expect } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  readReactRenders,
  recordReactRenders,
  resetReactRenders,
} from "../support/helpers/react-renders";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

async function createMockAgent(workspace: SeededWorkspace, title: string): Promise<string> {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title,
    modeId: "load-test",
    model: "e2e-fast-stream",
  });
  return agent.id;
}

test.describe("Updates to agents in other workspaces", () => {
  let open: SeededWorkspace;
  let other: SeededWorkspace;

  test.afterEach(async () => {
    await open?.cleanup();
    await other?.cleanup();
  });

  test("do not re-render the open workspace screen", async ({ page }) => {
    open = await seedWorkspace({ repoPrefix: "unrelated-update-open-", title: "Open" });
    other = await seedWorkspace({ repoPrefix: "unrelated-update-other-", title: "Other" });
    const openAgentId = await createMockAgent(open, "Open agent");
    const otherAgentId = await createMockAgent(other, "Other agent");

    await recordReactRenders(page);
    await openAgentRoute(page, { workspaceId: open.workspaceId, agentId: openAgentId });
    await expect(
      page.getByTestId(`workspace-tab-agent_${openAgentId}`).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2_000);
    await resetReactRenders(page);

    await other.client.sendAgentMessage(otherAgentId, "update");
    await other.client.waitForFinish(otherAgentId, 60_000);
    // The favicon follows every agent on the host, so it renders when the other agent runs and
    // settles. That confirms the updates reached this page.
    await expect
      .poll(async () => (await readReactRenders(page)).FaviconStatusSync ?? 0)
      .toBeGreaterThan(0);

    const renders = await readReactRenders(page);
    expect(renders.WorkspaceScreenContent ?? 0).toBe(0);
  });
});
