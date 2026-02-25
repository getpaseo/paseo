import { test, expect } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test('agent timeline hydrates after reload via fetch_agent_timeline_request', async ({ page }) => {
  const repo = await createTempGitRepo();
  const prompt = 'Respond with exactly: TIMELINE_HYDRATION_OK';

  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, prompt);
    await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({
      timeout: 30000,
    });

    await page.reload({ waitUntil: 'commit' });
    await expect(page).toHaveURL(/\/agent\//);
    await expect(page.getByTestId('agent-loading')).toHaveCount(0, { timeout: 30000 });
    await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({
      timeout: 30000,
    });
  } finally {
    await repo.cleanup();
  }
});
