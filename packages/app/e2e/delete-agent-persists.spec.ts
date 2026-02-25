import { test, expect } from './fixtures';
import { ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test('deleting an agent persists after reload', async ({ page }) => {
  const repo = await createTempGitRepo();
  const nonce = Math.random().toString(36).slice(2, 10);
  const prompt = `respond-ready-${nonce}`;

  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);

    // Create agent (via message input) so it shows up in the sidebar list.
    const input = page.getByRole('textbox', { name: 'Message agent...' });
    await expect(input).toBeEditable();
    await input.fill(prompt);
    await input.press('Enter');
    await expect(page).toHaveURL(/\/h\/[^/]+\/agent\/[^/?#]+(?:\?|$)/, {
      timeout: 30000,
    });
    // Wait for the initial turn to complete so the agent can be archived (web uses a hover action).
    const stopOrCancel = page.getByRole('button', { name: /Stop agent|Canceling agent/ });
    await stopOrCancel.first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => undefined);
    await expect(stopOrCancel).toHaveCount(0, { timeout: 120000 });

    const match =
      page.url().match(/\/h\/([^/]+)\/agent\/([^/?#]+)/) ??
      page.url().match(/\/agent\/([^/]+)\/([^/?#]+)/);
    if (!match) {
      throw new Error(`Expected /h/:serverId/agent/:agentId URL, got ${page.url()}`);
    }
    const serverId = decodeURIComponent(match[1]);
    const agentId = decodeURIComponent(match[2]);

    // Return home and delete via long-press in the agent list.
    await gotoHome(page);
    const rowTestId = `agent-row-${serverId}-${agentId}`;
    const agentRow = page.getByTestId(rowTestId).first();
    await expect(agentRow).toBeVisible({ timeout: 30000 });

    // Web UX: hover shows a quick-archive icon. First click enters confirm state; second click archives.
    await agentRow.hover();
    const quickArchive = page.getByTestId(`agent-archive-${serverId}-${agentId}`).first();
    await expect(quickArchive).toBeVisible({ timeout: 10000 });
    await quickArchive.click({ force: true });
    const confirmArchive = page
      .getByTestId(`agent-archive-confirm-${serverId}-${agentId}`)
      .first();
    await expect(confirmArchive).toBeVisible({ timeout: 10000 });
    await confirmArchive.click({ force: true });

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
