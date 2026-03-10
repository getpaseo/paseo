import { test, expect } from './fixtures';
import { buildDirectTcpConnection } from './helpers/daemon-registry';
import { gotoHome, openSettings } from './helpers/app';

test('relay connection stays stable across multiple tabs', async ({ page }) => {
  const relayPort = process.env.E2E_RELAY_PORT;
  const serverId = process.env.E2E_SERVER_ID;
  const daemonPublicKeyB64 = process.env.E2E_RELAY_DAEMON_PUBLIC_KEY;
  if (!relayPort || !serverId || !daemonPublicKeyB64) {
    throw new Error(
      'E2E_RELAY_PORT, E2E_SERVER_ID, or E2E_RELAY_DAEMON_PUBLIC_KEY is not set (expected from globalSetup).'
    );
  }

  const nowIso = new Date().toISOString();
  const relayEndpoint = `127.0.0.1:${relayPort}`;

  const host = {
    serverId,
    label: 'relay-daemon',
    connections: [
      buildDirectTcpConnection('127.0.0.1:9'),
      { id: `relay:${relayEndpoint}`, type: 'relay', relayEndpoint, daemonPublicKeyB64 },
    ],
    preferredConnectionId: 'direct:127.0.0.1:9',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Use relay by making the direct endpoint intentionally fail.
  await gotoHome(page);
  await openSettings(page);
  await page.evaluate((daemon) => {
    const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
    localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify([daemon]));
    localStorage.removeItem('@paseo:settings');
  }, host);
  await page.reload();

  const card = page.getByTestId(`daemon-card-${serverId}`);
  await expect(card.getByText('Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(card.getByText('Online', { exact: true })).toBeVisible({ timeout: 20000 });

  // Open a second tab. It should be able to connect independently without forcing disconnect churn.
  const page2 = await page.context().newPage();
  await page2.route(/:(6767)\b/, (route) => route.abort());
  await page2.routeWebSocket(/:(6767)\b/, async (ws) => {
    await ws.close({ code: 1008, reason: 'Blocked connection to localhost:6767 during e2e.' });
  });
  await page2.goto('/');
  const settingsButton2 = page2.locator('[data-testid="sidebar-settings"]:visible').first();
  await expect(settingsButton2).toBeVisible({ timeout: 20000 });
  await settingsButton2.click();
  const card2 = page2.getByTestId(`daemon-card-${serverId}`);
  await expect(card2.getByText('Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(card2.getByText('Online', { exact: true })).toBeVisible({ timeout: 20000 });

  // Stability window: keep both tabs open and ensure they remain online.
  await page.waitForTimeout(30_000);
  await expect(card.getByText('Online', { exact: true })).toBeVisible();
  await expect(card2.getByText('Online', { exact: true })).toBeVisible();
});
