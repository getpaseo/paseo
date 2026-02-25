import { test, expect } from './fixtures';

test('host removal removes the host from UI and persists after reload', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  const seededServerId = process.env.E2E_SERVER_ID;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }
  if (!seededServerId) {
    throw new Error('E2E_SERVER_ID is not set (expected from globalSetup).');
  }

  const extraPort = Number(daemonPort) + 1;
  const extraEndpoint = `127.0.0.1:${extraPort}`;
  const nowIso = new Date().toISOString();

  const extraDaemon = {
    serverId: 'srv_e2e_extra_daemon',
    label: 'extra',
    connections: [
      { id: `direct:${extraEndpoint}`, type: 'direct', endpoint: extraEndpoint },
    ],
    preferredConnectionId: `direct:${extraEndpoint}`,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const seededTestDaemon = {
    serverId: seededServerId,
    label: 'localhost',
    connections: [
      { id: `direct:127.0.0.1:${daemonPort}`, type: 'direct', endpoint: `127.0.0.1:${daemonPort}` },
    ],
    preferredConnectionId: `direct:127.0.0.1:${daemonPort}`,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const seedOnceKey = `@paseo:e2e-host-removal-seeded:${Math.random().toString(36).slice(2)}`;

  // Add a second host once (fixtures seed the primary host on every navigation).
  await page.addInitScript(
    ({ daemon, seededTestDaemon, seedOnceKey }) => {
      if (localStorage.getItem(seedOnceKey)) {
        return;
      }

      const raw = localStorage.getItem('@paseo:daemon-registry');
      let parsed: any[] = [];
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = [];
        }
      }
      const list = Array.isArray(parsed) ? parsed : [];
      localStorage.setItem(seedOnceKey, '1');

      const next = [...list];
      const hasSeeded = next.some((entry: any) => entry && entry.serverId === seededTestDaemon.serverId);
      if (!hasSeeded) {
        next.push(seededTestDaemon);
      }

      const alreadyPresent = next.some((entry: any) => entry && entry.serverId === daemon.serverId);
      if (!alreadyPresent) {
        next.push(daemon);
      }

      localStorage.setItem('@paseo:daemon-registry', JSON.stringify(next));
    },
    { daemon: extraDaemon, seededTestDaemon, seedOnceKey }
  );

  await page.goto('/settings');

  await expect(page.getByText('extra', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(extraEndpoint, { exact: true }).first()).toBeVisible();

  const hostSettingsButton = page.getByTestId(`daemon-card-settings-${extraDaemon.serverId}`).first();
  await expect(hostSettingsButton).toBeVisible({ timeout: 10000 });
  await hostSettingsButton.click();

  const hostDetailModal = page.getByTestId('host-detail-modal');
  await expect(hostDetailModal).toBeVisible({ timeout: 10000 });
  await hostDetailModal.getByText('Advanced', { exact: true }).click();
  await page.getByText('Remove host', { exact: true }).last().click();

  await expect(page.getByTestId('remove-host-confirm-modal')).toBeVisible();
  await page.getByTestId('remove-host-confirm').click();

  await expect(page.getByTestId(`daemon-card-${extraDaemon.serverId}`)).toHaveCount(0, {
    timeout: 30000,
  });
  await expect(page.getByText(extraEndpoint, { exact: true })).toHaveCount(0);
  await page.waitForFunction(
    (serverId) => {
      const raw = localStorage.getItem('@paseo:daemon-registry');
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && !parsed.some((entry: any) => entry && entry.serverId === serverId);
      } catch {
        return false;
      }
    },
    extraDaemon.serverId,
    { timeout: 10000 }
  );

  // Prevent the fixture from overwriting storage on reload; verify persistence.
  await page.evaluate(() => {
    const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
    localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
  });
  await page.reload();
  await expect(page.getByText(extraEndpoint, { exact: true })).toHaveCount(0);
});
