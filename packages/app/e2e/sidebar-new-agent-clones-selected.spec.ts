import { test, expect } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test('sidebar New Agent opens a fresh create screen', async ({ page }) => {
  const repoA = await createTempGitRepo();

  try {
    await gotoHome(page);
    await ensureHostSelected(page);

    await setWorkingDirectory(page, repoA.path);
    await createAgent(page, 'Agent A: respond with exactly A');
    await expect(page).toHaveURL(/\/agent\//);

    // Click sidebar New Agent and assert it does not carry over agent settings via URL.
    await page.getByTestId('sidebar-new-agent').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page).not.toHaveURL(new RegExp(encodeURIComponent(repoA.path)));
  } finally {
    await repoA.cleanup();
  }
});
