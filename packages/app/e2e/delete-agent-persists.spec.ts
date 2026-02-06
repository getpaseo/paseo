import { test, expect } from './fixtures';
import { ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test('deleting an agent persists after reload', async ({ page }) => {
  const repo = await createTempGitRepo();
  const nonce = Math.random().toString(36).slice(2, 10);
  const prompt = `delete-agent-persists-${nonce}`;

  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);

    // Create agent (via message input) so it shows up in the sidebar list.
    const input = page.getByRole('textbox', { name: 'Message agent...' });
    await expect(input).toBeEditable();
    await input.fill(prompt);
    await input.press('Enter');
    await page.waitForURL(/\/agent\//, { waitUntil: 'commit' });
    // Wait for the initial turn to complete so the agent can be archived (web uses a hover action).
    await expect(page.getByText('Hello world')).toBeVisible({ timeout: 30000 });

    const match = page.url().match(/\/agent\/([^/]+)\/([^/?#]+)/);
    if (!match) {
      throw new Error(`Expected /agent/:serverId/:agentId URL, got ${page.url()}`);
    }
    const serverId = decodeURIComponent(match[1]);
    const agentId = decodeURIComponent(match[2]);

    // Return home and delete via long-press in the agent list.
    await gotoHome(page);
    const rowTestId = `agent-row-${serverId}-${agentId}`;
    const agentRow = page.getByTestId(rowTestId).first();
    await expect(agentRow).toBeVisible({ timeout: 30000 });

    // Web UX: hover shows a quick-archive icon. (Long-press is touch-oriented and unreliable on desktop web.)
    await agentRow.hover();
    const quickArchive = page.getByTestId(`agent-archive-${serverId}-${agentId}`).first();
    await expect(quickArchive).toBeVisible({ timeout: 10000 });
    await quickArchive.click({ force: true });

    // Ensure deletion finished before reload (avoids races).
    await expect(page.getByTestId(rowTestId)).toHaveCount(0, { timeout: 30000 });

    // A full reload should not bring the agent back.
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeVisible();
    await expect(page.getByTestId(rowTestId)).toHaveCount(0, { timeout: 30000 });
  } finally {
    await repo.cleanup();
  }
});
