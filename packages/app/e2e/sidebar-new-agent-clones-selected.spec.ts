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

    // Click sidebar New Agent and assert it re-opens the host draft route while
    // preserving working directory context from the selected agent.
    await page.getByTestId('sidebar-new-agent').click();
    await expect(page).toHaveURL(/\/h\/[^/]+\/agent(\?|$)/);
    const searchWorkingDir = await page.evaluate(() => {
      try {
        return new URL(window.location.href).searchParams.get('workingDir');
      } catch {
        return null;
      }
    });
    const normalizedCandidates = new Set<string>([repoA.path]);
    if (repoA.path.startsWith('/var/')) {
      normalizedCandidates.add(`/private${repoA.path}`);
    }
    if (repoA.path.startsWith('/private/var/')) {
      normalizedCandidates.add(repoA.path.replace(/^\/private/, ''));
    }
    expect(searchWorkingDir).not.toBeNull();
    expect(normalizedCandidates.has(searchWorkingDir ?? '')).toBe(true);
  } finally {
    await repoA.cleanup();
  }
});
