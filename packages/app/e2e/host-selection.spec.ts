import { test, expect } from './fixtures';
import {
  buildCreateAgentPreferences,
  buildSeededHost,
} from './helpers/daemon-registry';
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
  const testDaemon = buildSeededHost({
    serverId,
    endpoint: `127.0.0.1:${daemonPort}`,
    nowIso,
  });
  const createAgentPreferences = buildCreateAgentPreferences(testDaemon.serverId);

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
  await expect(page.getByText('Settings', { exact: true }).first()).toBeVisible({ timeout: 20000 });
  await expect(page.locator(`[data-testid="daemon-card-${serverId}"]:visible`).first()).toBeVisible({
    timeout: 20000,
  });

  await page.goto(`/?serverId=${encodeURIComponent(serverId)}`);
  await expect(page.getByText('New agent', { exact: true }).first()).toBeVisible();

  const newAgentButton = page.getByTestId('sidebar-new-agent').first();
  if (await newAgentButton.isVisible().catch(() => false)) {
    await newAgentButton.click();
  } else {
    await page.getByText('New agent', { exact: true }).first().click();
  }

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
  const testDaemon = buildSeededHost({
    serverId,
    endpoint: `127.0.0.1:${daemonPort}`,
    nowIso,
  });

  await gotoHome(page);
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

  // Host should be auto-selected (no manual selection required).
  await expect(page.getByText('localhost', { exact: true }).first()).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable({ timeout: 30000 });
});
