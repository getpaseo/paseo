import { test, expect } from './fixtures';
import { gotoHome, openSettings } from './helpers/app';

test('daemon is connected in settings', async ({ page }) => {
  await gotoHome(page);
  await openSettings(page);

  await expect(page.getByText('localhost', { exact: true })).toBeVisible();
  await expect(page.getByText('ws://localhost:6767/ws')).toBeVisible();
  await expect(page.getByText('Online', { exact: true })).toBeVisible();
});
