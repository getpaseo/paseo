import { test, expect } from './fixtures';
import { gotoHome, openSettings } from './helpers/app';

test('daemon is connected in settings', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }

  await gotoHome(page);
  await openSettings(page);

  await expect(page.getByText(`ws://localhost:${daemonPort}/ws`)).toBeVisible();
  await expect(page.getByText('Online', { exact: true })).toBeVisible();
});
