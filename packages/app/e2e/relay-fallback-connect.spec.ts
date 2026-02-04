import { test, expect } from './fixtures';

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
      { id: 'direct:127.0.0.1:9', type: 'direct', endpoint: '127.0.0.1:9' },
      { id: `relay:${relayEndpoint}`, type: 'relay', relayEndpoint, daemonPublicKeyB64 },
    ],
    preferredConnectionId: 'direct:127.0.0.1:9',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Override the default fixture seeding for this test.
  await page.goto('/settings');
  await page.evaluate((daemon) => {
    const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
    localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify([daemon]));
    localStorage.removeItem('@paseo:settings');
  }, host);
  await page.reload();

  // Should eventually connect through the relay candidate URL.
  await expect(page.getByText('Connected via relay', { exact: true }).first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Online', { exact: true }).first()).toBeVisible({ timeout: 20000 });
});
