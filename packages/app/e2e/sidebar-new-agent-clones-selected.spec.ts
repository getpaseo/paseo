import { test, expect } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test('sidebar New Agent clones the selected agent settings (not last created)', async ({ page }) => {
  const repoA = await createTempGitRepo();
  const repoB = await createTempGitRepo();

  try {
    await gotoHome(page);
    await ensureHostSelected(page);

    await setWorkingDirectory(page, repoA.path);
    await createAgent(page, 'Agent A: respond with exactly A');
    await expect(page).toHaveURL(/\/agent\//);
    const urlA = new URL(page.url());
    const agentPathA = urlA.pathname;

    await gotoHome(page);
    await ensureHostSelected(page);
    await setWorkingDirectory(page, repoB.path);
    await createAgent(page, 'Agent B: respond with exactly B');
    await expect(page).toHaveURL(/\/agent\//);
    const urlB = new URL(page.url());
    const agentPathB = urlB.pathname;

    expect(agentPathA).not.toEqual(agentPathB);

    // Navigate back to agent A via URL to ensure it's the selected agent.
    await page.goto(agentPathA);
    await expect(page).toHaveURL(agentPathA);
    await expect(page.getByText('Agent A: respond with exactly A', { exact: true })).toBeVisible();

    // Click sidebar New Agent and assert it clones agent A's directory (not agent B's).
    await page.getByTestId('sidebar-new-agent').click();
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(repoA.path)));
    await expect(page).not.toHaveURL(new RegExp(encodeURIComponent(repoB.path)));
    await expect(page.getByText(repoA.path, { exact: true })).toBeVisible();

    // Now navigate to agent B and assert cloning uses repo B.
    await page.goto(agentPathB);
    await expect(page).toHaveURL(agentPathB);
    await expect(page.getByText('Agent B: respond with exactly B', { exact: true })).toBeVisible();

    await page.getByTestId('sidebar-new-agent').click();
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(repoB.path)));
    await expect(page).not.toHaveURL(new RegExp(encodeURIComponent(repoA.path)));
    await expect(page.getByText(repoB.path, { exact: true })).toBeVisible();
  } finally {
    await repoA.cleanup();
    await repoB.cleanup();
  }
});

