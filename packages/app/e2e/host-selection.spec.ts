import { test, expect } from './fixtures';
import { ensureHostSelected, gotoHome } from './helpers/app';

test('new agent auto-selects the previous host', async ({ page }) => {
  await gotoHome(page);
  await ensureHostSelected(page);

  // Ensure preference is persisted so a full reload can restore it.
  await page.waitForFunction(() => {
    const stored = localStorage.getItem('@paseo:create-agent-preferences');
    if (!stored) return false;
    try {
      const parsed = JSON.parse(stored);
      return parsed?.serverId === 'e2e-test-daemon';
    } catch {
      return false;
    }
  });

  await gotoHome(page);

  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable();
});

test('new agent respects serverId in the URL', async ({ page }) => {
  await page.goto('/?serverId=e2e-test-daemon&serverId=e2e-test-daemon');
  await expect(page.getByText('New Agent', { exact: true }).first()).toBeVisible();

  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable();
});

