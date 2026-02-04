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
  // Override the default fixture seeding for this test.
  await page.goto('/settings');
  await page.evaluate(() => {
    const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
    localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify([]));
    localStorage.removeItem('@paseo:settings');
  });
  await page.reload();

  const offer = {
    v: 2 as const,
    serverId: 'e2e-server-123',
    daemonPublicKeyB64: Buffer.from('e2e-public-key', 'utf8').toString('base64'),
    relay: { endpoint: 'relay.local:443' },
  };

  const offerUrl = `https://app.paseo.sh/#offer=${encodeBase64Url(JSON.stringify(offer))}`;

  await page.getByText('+ Add host', { exact: true }).click();
  await page.getByText('Paste pairing link', { exact: true }).click();

  const input = page.getByPlaceholder('https://app.paseo.sh/#offer=...');
  await expect(input).toBeVisible();
  await input.fill(offerUrl);

  await page.getByText('Pair', { exact: true }).click();

  await expect(page.getByTestId('sidebar-new-agent')).toBeVisible();

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
