import { test, expect } from './fixtures';
import { Buffer } from 'node:buffer';

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

test('pairing flow accepts #offer=ConnectionOfferV1 and stores sessionId + endpoints', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }

  // Override the default fixture seeding for this test.
  await page.goto('/settings');
  await page.evaluate(() => {
    localStorage.setItem('@paseo:e2e-disable-default-seed-once', '1');
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify([]));
    localStorage.removeItem('@paseo:settings');
  });
  await page.reload();

  const offer = {
    v: 1 as const,
    sessionId: 'e2e-session-123',
    endpoints: [`127.0.0.1:${daemonPort}`, 'relay.local:443'],
    daemonPublicKeyB64: Buffer.from('e2e-public-key', 'utf8').toString('base64'),
  };

  const offerUrl = `https://app.paseo.sh/#offer=${encodeBase64Url(JSON.stringify(offer))}`;

  await page.getByText('+ Add Host', { exact: true }).click();
  await page.getByText('Pair', { exact: true }).click();

  const input = page.getByPlaceholder('https://app.paseo.sh/#offer=...');
  await expect(input).toBeVisible();
  await input.fill(offerUrl);

  await page.getByText('Pair', { exact: true }).click();

  await expect(page.getByText(`127.0.0.1:${daemonPort}`, { exact: true })).toBeVisible();

  await page.waitForFunction(
    ({ expected }) => {
      const raw = localStorage.getItem('@paseo:daemon-registry');
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length !== 1) return false;
        const entry = parsed[0];
        return (
          entry?.daemonPublicKeyB64 === expected.daemonPublicKeyB64 &&
          entry?.relay?.sessionId === expected.sessionId &&
          Array.isArray(entry?.endpoints) &&
          entry.endpoints[0] === expected.endpoints[0] &&
          entry.endpoints[1] === expected.endpoints[1]
        );
      } catch {
        return false;
      }
    },
    { expected: offer },
    { timeout: 10000 }
  );
});
