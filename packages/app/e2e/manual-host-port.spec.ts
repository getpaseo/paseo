import { test, expect } from './fixtures';

test('manual host add accepts host:port only and persists a direct connection', async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  const serverId = process.env.E2E_SERVER_ID;
  if (!daemonPort) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from globalSetup).');
  }
  if (!serverId) {
    throw new Error('E2E_SERVER_ID is not set (expected from globalSetup).');
  }

  // Override the default fixture seeding for this navigation (must run before app boot).
  await page.addInitScript(() => {
    localStorage.setItem('@paseo:daemon-registry', JSON.stringify([]));
    localStorage.removeItem('@paseo:settings');
  });
  await page.goto('/settings');

  await page.getByText('+ Add host', { exact: true }).click();
  await page.getByText('Direct connection', { exact: true }).click();

  const input = page.getByPlaceholder('host:6767');
  await expect(input).toBeVisible();
  await input.fill(`127.0.0.1:${daemonPort}`);

  await page.getByText('Connect & Save', { exact: true }).click();

  await expect(page.getByTestId('sidebar-new-agent')).toBeVisible();
  await expect(page.getByText('Online', { exact: true })).toBeVisible({ timeout: 15000 });

  await page.waitForFunction(
    ({ port, serverId }) => {
      const raw = localStorage.getItem('@paseo:daemon-registry');
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length !== 1) return false;
        const entry = parsed[0];
        return (
          entry?.serverId === serverId &&
          Array.isArray(entry?.connections) &&
          entry.connections.some(
            (conn: any) => conn?.type === 'direct' && conn?.endpoint === `127.0.0.1:${port}`
          )
        );
      } catch {
        return false;
      }
    },
    { port: daemonPort, serverId },
    { timeout: 10000 }
  );
});
