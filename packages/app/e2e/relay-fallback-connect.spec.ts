import { test, expect } from './fixtures';

test('connects via relay when direct endpoints fail', async ({ page }) => {
  const relayPort = process.env.E2E_RELAY_PORT;
  const sessionId = process.env.E2E_RELAY_SESSION_ID;
  const daemonPublicKeyB64 = process.env.E2E_RELAY_DAEMON_PUBLIC_KEY;
  if (!relayPort || !sessionId || !daemonPublicKeyB64) {
    throw new Error(
      'E2E_RELAY_PORT, E2E_RELAY_SESSION_ID, or E2E_RELAY_DAEMON_PUBLIC_KEY is not set (expected from globalSetup).'
    );
  }

  const nowIso = new Date().toISOString();
  const relayEndpoint = `127.0.0.1:${relayPort}`;

  const host = {
    id: 'relay-only-daemon',
    label: 'relay-daemon',
    endpoints: [relayEndpoint],
    daemonPublicKeyB64,
    relay: { endpoint: relayEndpoint, sessionId },
    metadata: null,
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
  await expect(page.getByText(relayEndpoint, { exact: true })).toBeVisible();
  await expect(page.getByText('Online', { exact: true }).first()).toBeVisible({ timeout: 20000 });
});
