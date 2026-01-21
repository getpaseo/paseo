import { test, expect } from './fixtures';

test('legacy wsUrl registry entries migrate to host:port endpoints', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }

  const nowIso = new Date().toISOString();
  const legacy = [
    {
      id: 'legacy-daemon',
      label: 'localhost',
      wsUrl: `ws://127.0.0.1:${daemonPort}/ws`,
      createdAt: nowIso,
      updatedAt: nowIso,
      metadata: null,
    },
  ];

  // Override the default fixture seeding for this navigation (must run before app boot).
  await page.addInitScript((legacyRegistry) => {
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify(legacyRegistry));
    localStorage.removeItem('@paseo:settings');
  }, legacy);
  await page.goto('/settings');
  await expect(page.getByText(`127.0.0.1:${daemonPort}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Online', { exact: true }).first()).toBeVisible({ timeout: 15000 });

  await page.waitForFunction(
    (port) => {
      const raw = localStorage.getItem('@paseo:daemon-registry');
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length !== 1) return false;
        const entry = parsed[0];
        const hasWsUrl = typeof entry?.wsUrl === 'string';
        return !hasWsUrl && Array.isArray(entry?.endpoints) && entry.endpoints[0] === `127.0.0.1:${port}`;
      } catch {
        return false;
      }
    },
    daemonPort,
    { timeout: 10000 }
  );
});
