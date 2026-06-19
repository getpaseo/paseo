import { expect, test } from "./fixtures";
import { clickNewChat, clickNewTerminal, gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import {
  expectTerminalSurfaceVisible,
  focusTerminalSurface,
  typeInTerminal,
  setupDeterministicPrompt,
  waitForTerminalContent,
} from "./helpers/terminal-perf";

interface CreatedAgentCwdAssertion {
  workspaceId: string;
  cwd: string | null;
}

async function fetchSingleAgentForWorkspace(
  workspace: SeededWorkspace,
): Promise<CreatedAgentCwdAssertion | null> {
  const agents = (await workspace.client.fetchAgents({ scope: "active" })).entries
    .map((entry) => entry.agent)
    .filter((agent) => agent.workspaceId === workspace.workspaceId);
  if (agents.length !== 1) {
    return null;
  }
  const [agent] = agents;
  return {
    workspaceId: workspace.workspaceId,
    cwd: agent.cwd,
  };
}

test.describe("Workspace cwd correctness", () => {
  test("main checkout workspace opens terminals in the project root", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);

    const workspace = await withWorkspace({ prefix: "workspace-cwd-main-" });
    await workspace.navigateTo();
    await clickNewTerminal(page);

    await expectTerminalSurfaceVisible(page);
    await focusTerminalSurface(page);
    await setupDeterministicPrompt(page, `PWD_READY_${Date.now()}`);
    await typeInTerminal(page, "pwd\n");
    await waitForTerminalContent(page, (text) => text.includes(workspace.repoPath), 10_000);
  });

  test("draft tab creates an agent in the workspace cwd", async ({ page }) => {
    test.setTimeout(60_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-cwd-draft-agent-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);

      await clickNewChat(page);
      const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
      const message = `cwd draft create ${Date.now()}`;
      await expect(composer).toBeEditable({ timeout: 15_000 });
      await composer.fill(message);
      await composer.press("Enter");
      await expect(page.getByText(message, { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });

      await expect(page.locator('[data-testid^="workspace-tab-agent_"]').first()).toBeVisible({
        timeout: 30_000,
      });

      await expect
        .poll(() => fetchSingleAgentForWorkspace(workspace), { timeout: 30_000 })
        .toEqual({
          workspaceId: workspace.workspaceId,
          cwd: workspace.repoPath,
        });
    } finally {
      await workspace.cleanup();
    }
  });

  test("worktree workspace opens terminals in the worktree directory", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);

    const workspace = await withWorkspace({ worktree: true, prefix: "workspace-cwd-worktree-" });
    await workspace.navigateTo();
    await clickNewTerminal(page);

    await expectTerminalSurfaceVisible(page);
    await focusTerminalSurface(page);
    await setupDeterministicPrompt(page, `PWD_READY_${Date.now()}`);
    await typeInTerminal(page, "pwd\n");
    await waitForTerminalContent(page, (text) => text.includes(workspace.repoPath), 10_000);
  });
});
