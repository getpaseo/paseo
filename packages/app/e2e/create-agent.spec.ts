import { test, expect } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

function parseAgentUrl(url: string): { serverId: string; agentId: string } {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/h\/([^/]+)\/agent\/([^/?#]+)/);
  if (!match) {
    throw new Error(`Expected /h/:serverId/agent/:agentId URL, got ${url}`);
  }
  return {
    serverId: decodeURIComponent(match[1]),
    agentId: decodeURIComponent(match[2]),
  };
}

test('create agent in a temp repo', async ({ page }) => {
  const repo = await createTempGitRepo();
  const prompt = "Respond with exactly: Hello";

  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, prompt);

    // Verify user message is shown in the stream
    await expect(page.getByText(prompt, { exact: true })).toBeVisible();

    // Verify we used the seeded fast model (do not fall back to other defaults).
    await page.getByTestId('agent-overflow-menu').click();
    await expect(page.getByText('Model', { exact: true })).toBeVisible();
    await expect(
      page.getByTestId('agent-overflow-content').getByText(/gpt-5\.1-codex-mini/i)
    ).toBeVisible();

    // Verify the created agent's title reflects the response.
    const { serverId, agentId } = parseAgentUrl(page.url());
    const agentRow = page.getByTestId(`agent-row-${serverId}-${agentId}`).first();
    await expect(agentRow).not.toContainText(/new agent/i, { timeout: 30000 });
    await expect(agentRow).toContainText(/hello|greet|response/i, { timeout: 30000 });
  } finally {
    await repo.cleanup();
  }
});
