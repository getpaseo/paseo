import { test, expect } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test('create agent in a temp repo', async ({ page }) => {
  const repo = await createTempGitRepo();
  const message = `E2E create agent ${Date.now()}`;

  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, message);
  } finally {
    await repo.cleanup();
  }
});
