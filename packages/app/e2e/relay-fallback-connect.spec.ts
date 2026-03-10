import { test, expect } from './fixtures';
import { buildDirectTcpConnection } from './helpers/daemon-registry';
import { gotoHome, openSettings } from './helpers/app';

test('connects via relay when direct endpoints fail', async ({ page }) => {
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

  // Override the default fixture seeding for this test.
  await gotoHome(page);
  await openSettings(page);
  await page.evaluate((daemon) => {
    const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
    localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify([daemon]));
    localStorage.removeItem('@paseo:settings');
  }, host);
  await page.reload();

  // Should eventually connect through the relay connection.
  const card = page.getByTestId(`daemon-card-${serverId}`);
  await expect(card.getByText('Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(card.getByText('Online', { exact: true })).toBeVisible({ timeout: 20000 });
});
