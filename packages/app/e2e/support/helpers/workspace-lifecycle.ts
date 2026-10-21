import { expect, type Page } from "@playwright/test";
import { clickNewChat, clickNewTerminal } from "./launcher";
import { connectSeedClient } from "./seed-client";
import { setupDeterministicPrompt, waitForTerminalContent } from "./terminal-perf";

function terminalSurface(page: Page) {
  return page.locator('[data-testid="terminal-surface"]').first();
}

function composerInput(page: Page) {
  return page.getByRole("textbox", { name: "Message agent..." }).first();
}

export async function expectTerminalCwd(page: Page, expectedPath: string): Promise<void> {
  const terminal = terminalSurface(page);
  await expect(terminal).toBeVisible({ timeout: 20_000 });
  await terminal.click();
  await setupDeterministicPrompt(page, `SENTINEL_${Date.now()}`);
  await terminal.pressSequentially("pwd\n", { delay: 0 });
  await waitForTerminalContent(page, (text) => text.includes(expectedPath), 10_000);
}

export async function createStandaloneTerminalFromLauncher(page: Page): Promise<void> {
  await clickNewTerminal(page);
  await expect(terminalSurface(page)).toBeVisible({ timeout: 20_000 });
}

export async function createAgentChatFromLauncher(page: Page): Promise<void> {
  await clickNewChat(page);
  await expect(composerInput(page)).toBeVisible({ timeout: 15_000 });
  await expect(composerInput(page)).toBeEditable({ timeout: 15_000 });
  await expect(page.getByTestId("agent-loading")).toHaveCount(0);
}

export async function submitAgentChatAndExpectCwd(
  page: Page,
  workspace: { workspaceId: string; repoPath: string },
): Promise<void> {
  const client = await connectSeedClient();
  try {
    const message = "cwd draft create";
    await composerInput(page).fill(message);
    await composerInput(page).press("Enter");
    await expect(page.getByText(message, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid^="workspace-tab-agent_"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(
        async () => {
          const agents = await client.fetchAgents({ scope: "active" });
          return agents.entries
            .map((entry) => entry.agent)
            .filter((agent) => agent.workspaceId === workspace.workspaceId)
            .map((agent) => ({ workspaceId: agent.workspaceId, cwd: agent.cwd }));
        },
        { timeout: 30_000 },
      )
      .toEqual([{ workspaceId: workspace.workspaceId, cwd: workspace.repoPath }]);
  } finally {
    await client.close();
  }
}
