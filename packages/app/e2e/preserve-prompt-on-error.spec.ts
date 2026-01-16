import { test, expect } from './fixtures';
import { gotoHome, ensureHostSelected, setWorkingDirectory } from './helpers/app';

test('preserves prompt text when trying to create agent with non-existent directory', async ({ page }) => {
  const nonExistentDir = '/non/existent/directory/that/does/not/exist';
  const promptText = `Test prompt that should be preserved ${Date.now()}`;

  await gotoHome(page);
  await ensureHostSelected(page);
  await setWorkingDirectory(page, nonExistentDir);

  // Enter prompt text
  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable();
  await input.fill(promptText);

  // Try to submit - this should fail with an error about the directory not existing
  await input.press('Enter');

  // Verify error message is displayed (error includes the path)
  await expect(page.getByText(/Working directory does not exist/)).toBeVisible();

  // Verify the prompt text is still preserved in the input
  await expect(input).toHaveValue(promptText);
});
