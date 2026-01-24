import { test, expect } from './fixtures';
import { gotoHome, openSettings } from './helpers/app';

test('daemon is connected in settings', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }

  await gotoHome(page);
  await openSettings(page);

  await expect(page.getByText(`127.0.0.1:${daemonPort}`)).toBeVisible();
  await expect(page.getByTestId('daemon-card-e2e-test-daemon').getByText('Online', { exact: true })).toBeVisible();
});
