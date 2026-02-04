import { test, expect } from './fixtures';
import { ensureHostSelected, gotoHome } from './helpers/app';

test('new agent auto-selects the previous host', async ({ page }) => {
  await gotoHome(page);
  await ensureHostSelected(page);

  await gotoHome(page);

  // The selected host should be restored after a full reload without manual selection.
  await expect(page.getByText('localhost', { exact: true }).first()).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable({ timeout: 30000 });
});

test('new agent respects serverId in the URL', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  const serverId = process.env.E2E_SERVER_ID;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }
  if (!serverId) {
    throw new Error('E2E_SERVER_ID is not set (expected from globalSetup).');
  }

  // Ensure this test's storage is deterministic even under parallel load.
  const nowIso = new Date().toISOString();
  const testDaemon = {
    serverId,
    label: 'localhost',
    connections: [
      {
        id: `direct:127.0.0.1:${daemonPort}`,
        type: 'direct',
        endpoint: `127.0.0.1:${daemonPort}`,
      },
    ],
    preferredConnectionId: `direct:127.0.0.1:${daemonPort}`,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const createAgentPreferences = {
    serverId: testDaemon.serverId,
    provider: 'claude',
    providerPreferences: {
      claude: { model: 'haiku' },
      codex: { model: 'gpt-5.1-codex-mini' },
    },
  };

  await page.goto('/settings');
  await page.evaluate(
    ({ daemon, preferences }) => {
      const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
      localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
      localStorage.setItem('@paseo:daemon-registry', JSON.stringify([daemon]));
      localStorage.setItem('@paseo:create-agent-preferences', JSON.stringify(preferences));
      localStorage.removeItem('@paseo:settings');
    },
    { daemon: testDaemon, preferences: createAgentPreferences }
  );
  await page.reload();
  await expect(page.getByText('Online', { exact: true }).first()).toBeVisible({ timeout: 20000 });

  await page.goto(`/?serverId=${encodeURIComponent(serverId)}`);
  await expect(page.getByText('New agent', { exact: true }).first()).toBeVisible();

  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable({ timeout: 30000 });
});

test('new agent auto-selects first online host when no preference is stored', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  const serverId = process.env.E2E_SERVER_ID;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }
  if (!serverId) {
    throw new Error('E2E_SERVER_ID is not set (expected from globalSetup).');
  }

  const nowIso = new Date().toISOString();
  const testDaemon = {
    serverId,
    label: 'localhost',
    connections: [
      {
        id: `direct:127.0.0.1:${daemonPort}`,
        type: 'direct',
        endpoint: `127.0.0.1:${daemonPort}`,
      },
    ],
    preferredConnectionId: `direct:127.0.0.1:${daemonPort}`,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await page.goto('/');
  await page.evaluate(
    ({ daemon }) => {
      const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
      localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
      localStorage.setItem('@paseo:daemon-registry', JSON.stringify([daemon]));
      localStorage.removeItem('@paseo:create-agent-preferences');
      localStorage.removeItem('@paseo:settings');
    },
    { daemon: testDaemon }
  );

  await page.reload();
  await expect(page.getByText('New agent', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Online', { exact: true }).first()).toBeVisible({ timeout: 20000 });

  // Host should be auto-selected (no manual selection required).
  await expect(page.getByText('localhost', { exact: true }).first()).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable({ timeout: 30000 });
});
