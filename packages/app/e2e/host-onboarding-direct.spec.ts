import { test, expect } from './fixtures';

test('no hosts shows welcome; direct connection adds host and lands on agent create', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  const serverId = process.env.E2E_SERVER_ID;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }
  if (!serverId) {
    throw new Error('E2E_SERVER_ID is not set (expected from globalSetup).');
  }

  await page.addInitScript(() => {
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify([]));
    localStorage.removeItem('@paseo:create-agent-preferences');
    localStorage.removeItem('@paseo:settings');
  });

  await page.goto('/');

  await expect(page.getByText('Welcome to Paseo', { exact: true })).toBeVisible();

  await page.getByText('Direct connection', { exact: true }).click();

  await page.getByPlaceholder('host:6767').fill(`127.0.0.1:${daemonPort}`);

  await page.getByText('Connect', { exact: true }).click();

  // First-time connection prompts for an optional label.
  const nameModal = page.getByTestId('name-host-modal');
  const showedNameModal = await nameModal
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (showedNameModal) {
    await nameModal.getByTestId('name-host-skip').click();
  }

  await expect(page.getByTestId('sidebar-new-agent')).toBeVisible();
  await expect(page.getByText(serverId, { exact: true })).toBeVisible();
  await expect(page.getByText('Online', { exact: true })).toBeVisible({ timeout: 15000 });
});
