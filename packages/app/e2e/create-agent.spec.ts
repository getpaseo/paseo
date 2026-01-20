import { test, expect } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

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

    // Verify we used a fast model (do not fall back to a default like Sonnet).
    await page.getByTestId('agent-overflow-menu').click();
    await expect(page.getByText('Model', { exact: true })).toBeVisible();
    await expect(page.getByText(/haiku/i)).toBeVisible();

    // Wait for agent response containing "Hello" within an assistant message
    const assistantMessage = page.getByTestId('assistant-message').filter({ hasText: 'Hello' });
    await expect(assistantMessage).toBeVisible({ timeout: 30000 });
  } finally {
    await repo.cleanup();
  }
});
