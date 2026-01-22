import { test, expect } from './fixtures';

test('host removal removes the host from UI and persists after reload', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }

  const extraPort = Number(daemonPort) + 1;
  const extraEndpoint = `127.0.0.1:${extraPort}`;
  const nowIso = new Date().toISOString();

  const extraDaemon = {
    id: 'e2e-extra-daemon',
    label: 'extra',
    endpoints: [extraEndpoint],
    relay: null,
    metadata: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Add a second host once (fixtures seed the primary host on every navigation).
  await page.addInitScript(
    ({ daemon }) => {
      const seedOnceKey = '@paseo:e2e-extra-daemon-seeded-once';
      if (localStorage.getItem(seedOnceKey)) {
        return;
      }
      localStorage.setItem(seedOnceKey, '1');

      const raw = localStorage.getItem('@paseo:daemon-registry');
      let parsed: any[] = [];
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = [];
        }
      }
      const next = Array.isArray(parsed) ? [...parsed, daemon] : [daemon];
      localStorage.setItem('@paseo:daemon-registry', JSON.stringify(next));
    },
    { daemon: extraDaemon }
  );

  await page.goto('/settings');

  await expect(page.getByText('extra', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(extraEndpoint, { exact: true }).first()).toBeVisible();

  const removeButtons = page.getByText('Remove', { exact: true });
  await expect(removeButtons).toHaveCount(2);

  page.once('dialog', (dialog) => dialog.accept());
  await removeButtons.nth(1).click();

  await expect(page.getByText(extraEndpoint, { exact: true })).toHaveCount(0);
  await page.waitForFunction(
    (daemonId) => {
      const raw = localStorage.getItem('@paseo:daemon-registry');
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && !parsed.some((entry: any) => entry && entry.id === daemonId);
      } catch {
        return false;
      }
    },
    extraDaemon.id,
    { timeout: 10000 }
  );

  // Prevent the fixture from overwriting storage on reload; verify persistence.
  await page.evaluate(() => localStorage.setItem('@paseo:e2e-disable-default-seed-once', '1'));
  await page.reload();
  await expect(page.getByText(extraEndpoint, { exact: true })).toHaveCount(0);
});

