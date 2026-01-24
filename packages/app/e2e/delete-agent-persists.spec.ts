import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

async function longPress(page: Page, locator: Locator, durationMs = 1100) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Expected long-press target to have a bounding box.');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(durationMs);
  await page.mouse.up();
}

test('deleting an agent via long-press persists after reload', async ({ page }) => {
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

    await longPress(page, agentRow, 1200);

    const deleteButton = page.getByTestId('agent-action-delete').first();
    await expect(deleteButton).toBeVisible({ timeout: 10000 });
    await deleteButton.click({ force: true });
    await expect(page.getByTestId('agent-action-cancel')).toHaveCount(0, { timeout: 10000 });

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
