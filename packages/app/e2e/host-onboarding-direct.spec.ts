import { test, expect } from './fixtures';

test('no hosts shows welcome; direct connection adds host and lands on agent create', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }

  await page.addInitScript(() => {
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify([]));
    localStorage.removeItem('@paseo:create-agent-preferences');
    localStorage.removeItem('@paseo:settings');
  });

  await page.goto('/');

  await expect(page.getByText('Welcome to Paseo', { exact: true })).toBeVisible();

  await page.getByText('Direct connection', { exact: true }).click();

  await page.getByPlaceholder('My Host').fill('E2E Host');
  await page.getByPlaceholder('host:6767').fill(`127.0.0.1:${daemonPort}`);

  await page.getByText('Connect & Save', { exact: true }).click();

  await expect(page.getByTestId('sidebar-new-agent')).toBeVisible();
  await expect(page.getByText('E2E Host', { exact: true })).toBeVisible();
  await expect(page.getByText('Online', { exact: true })).toBeVisible({ timeout: 15000 });
});
