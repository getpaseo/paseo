import { test, expect } from './fixtures';
import { Buffer } from 'node:buffer';

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

test('pairing flow accepts #offer=ConnectionOfferV2 and stores relay-only host', async ({ page }) => {
  const relayPort = process.env.E2E_RELAY_PORT;
  const serverId = process.env.E2E_SERVER_ID;
  const daemonPublicKeyB64 = process.env.E2E_RELAY_DAEMON_PUBLIC_KEY;
  if (!relayPort || !serverId || !daemonPublicKeyB64) {
    throw new Error(
      'E2E_RELAY_PORT, E2E_SERVER_ID, or E2E_RELAY_DAEMON_PUBLIC_KEY is not set (expected from globalSetup).'
    );
  }

  // Override the default fixture seeding for this test.
  await page.goto('/settings');
  await page.evaluate(() => {
    const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
    localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify([]));
    localStorage.removeItem('@paseo:settings');
  });
  await page.goto('/');

  const relayEndpoint = `127.0.0.1:${relayPort}`;

  const offer = {
    v: 2 as const,
    serverId,
    daemonPublicKeyB64,
    relay: { endpoint: relayEndpoint },
  };

  const offerUrl = `https://app.paseo.sh/#offer=${encodeBase64Url(JSON.stringify(offer))}`;

  const welcomeTitle = page.getByText('Welcome to Paseo', { exact: true });
  if (await welcomeTitle.isVisible().catch(() => false)) {
    await page.getByTestId('welcome-paste-pairing-link').click();
  } else {
    await page.getByText('+ Add connection', { exact: true }).click();
    await page.getByText('Paste pairing link', { exact: true }).click();
  }

  const input = page.getByPlaceholder('https://app.paseo.sh/#offer=...');
  await expect(input).toBeVisible();
  await input.fill(offerUrl);

  await page.getByTestId('pair-link-submit').click();

  const nameHostModal = page.getByTestId('name-host-modal');
  if (await nameHostModal.isVisible().catch(() => false)) {
    await nameHostModal.getByTestId('name-host-skip').click();
  }

  await expect(page.getByTestId('sidebar-new-agent')).toBeVisible({ timeout: 30000 });

  await page.waitForFunction(
    ({ expected }) => {
      const raw = localStorage.getItem('@paseo:daemon-registry');
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length !== 1) return false;
        const entry = parsed[0];
        const relayId = `relay:${expected.relay.endpoint}`;
        return (
          entry?.serverId === expected.serverId &&
          Array.isArray(entry?.connections) &&
          entry.connections.length === 1 &&
          entry.connections[0]?.id === relayId &&
          entry.connections[0]?.type === 'relay' &&
          entry.connections[0]?.relayEndpoint === expected.relay.endpoint &&
          entry.connections[0]?.daemonPublicKeyB64 === expected.daemonPublicKeyB64
        );
      } catch {
        return false;
      }
    },
    { expected: offer },
    { timeout: 10000 }
  );
});
