import { test, expect } from './fixtures';
import { gotoHome, openSettings } from './helpers/app';

test('daemon is connected in settings', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT ?? '6767';

  await gotoHome(page);
  await openSettings(page);

  await expect(page.getByText('localhost', { exact: true })).toBeVisible();
  await expect(page.getByText(`ws://localhost:${daemonPort}/ws`)).toBeVisible();
  await expect(page.getByText('Online', { exact: true })).toBeVisible();
});
