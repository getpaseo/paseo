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
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }

  // Ensure this test's storage is deterministic even under parallel load.
  const nowIso = new Date().toISOString();
  const testDaemon = {
    id: 'e2e-test-daemon',
    label: 'localhost',
    endpoints: [`127.0.0.1:${daemonPort}`],
    relay: null,
    metadata: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const createAgentPreferences = {
    serverId: testDaemon.id,
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

  const seededDaemonId = await page.evaluate(() => {
    const raw = localStorage.getItem('@paseo:daemon-registry');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as any[];
    return Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.id === 'string'
      ? (parsed[0].id as string)
      : null;
  });
  if (!seededDaemonId) {
    throw new Error('Expected daemon registry to contain a seeded daemon id.');
  }

  await page.goto(`/?serverId=${encodeURIComponent(seededDaemonId)}`);
  await expect(page.getByText('New agent', { exact: true }).first()).toBeVisible();

  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable({ timeout: 30000 });
});

test('new agent auto-selects first online host when no preference is stored', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }

  const nowIso = new Date().toISOString();
  const testDaemon = {
    id: 'e2e-test-daemon',
    label: 'localhost',
    endpoints: [`127.0.0.1:${daemonPort}`],
    relay: null,
    metadata: null,
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

test('adopts daemon-provided serverId for legacy host ids', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }

  const nowIso = new Date().toISOString();
  const legacyId = 'legacy-daemon-id';
  const daemon = {
    id: legacyId,
    label: 'localhost',
    endpoints: [`127.0.0.1:${daemonPort}`],
    relay: null,
    metadata: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await page.goto('/settings');
  await page.evaluate(
    ({ daemon, legacyId }) => {
      const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
      localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
      localStorage.setItem('@paseo:daemon-registry', JSON.stringify([daemon]));
      localStorage.setItem(
        '@paseo:create-agent-preferences',
        JSON.stringify({
          serverId: legacyId,
          provider: 'claude',
          providerPreferences: {
            claude: { model: 'haiku' },
            codex: { model: 'gpt-5.1-codex-mini' },
          },
        })
      );
      localStorage.removeItem('@paseo:settings');
    },
    { daemon, legacyId }
  );

  await page.reload();
  await expect(page.getByText('Online', { exact: true }).first()).toBeVisible({ timeout: 20000 });

  // Wait for server_info handshake to rekey registry + preferences.
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('@paseo:daemon-registry');
      const prefsRaw = localStorage.getItem('@paseo:create-agent-preferences');
      if (!raw || !prefsRaw) return false;
      const registry = JSON.parse(raw);
      const prefs = JSON.parse(prefsRaw);
      if (!Array.isArray(registry) || registry.length !== 1) return false;
      if (registry[0]?.id !== 'e2e-test-daemon') return false;
      if (prefs?.serverId !== 'e2e-test-daemon') return false;
      const legacyIds = registry[0]?.metadata?.legacyIds;
      return Array.isArray(legacyIds) && legacyIds.includes('legacy-daemon-id');
    },
    { timeout: 20000 }
  );

  const snapshot = await page.evaluate(() => {
    const raw = localStorage.getItem('@paseo:daemon-registry');
    const prefsRaw = localStorage.getItem('@paseo:create-agent-preferences');
    return { raw, prefsRaw };
  });
  if (!snapshot.raw || !snapshot.prefsRaw) {
    throw new Error('Expected registry + preferences to be present after rekey.');
  }

  const registry = JSON.parse(snapshot.raw) as any[];
  expect(registry[0].id).toBe('e2e-test-daemon');
  expect(registry[0].metadata.legacyIds).toContain('legacy-daemon-id');

  const prefs = JSON.parse(snapshot.prefsRaw) as any;
  expect(prefs.serverId).toBe('e2e-test-daemon');
});
