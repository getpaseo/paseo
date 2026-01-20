import { test, expect, type Page } from '@playwright/test';

const consoleEntries = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error(
      'E2E_DAEMON_PORT is not set. Refusing to run e2e against the default daemon (e.g. localhost:6767). ' +
        'Ensure Playwright `globalSetup` starts the e2e daemon and exports E2E_DAEMON_PORT.'
    );
  }

  const entries: string[] = [];
  consoleEntries.set(page, entries);

  page.on('console', (message) => {
    entries.push(`[console:${message.type()}] ${message.text()}`);
  });

  page.on('pageerror', (error) => {
    entries.push(`[pageerror] ${error.message}`);
  });

  const nowIso = new Date().toISOString();
  const testDaemon = {
    id: 'e2e-test-daemon',
    label: 'localhost',
    wsUrl: `ws://localhost:${daemonPort}/ws`,
    restUrl: `http://localhost:${daemonPort}/`,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const createAgentPreferences = {
    // Ensure create flow never uses a remembered host from the developer's real app.
    serverId: testDaemon.id,
    // Keep e2e fast/cheap by default.
    provider: 'claude',
    providerPreferences: {
      claude: { model: 'haiku' },
      codex: { model: 'gpt-5.1-codex-mini' },
    },
  };

  await page.addInitScript(
    ({ daemon, preferences }) => {
      // Hard-reset anything that could point to a developer's real daemon.
      localStorage.setItem('@paseo:daemon-registry', JSON.stringify([daemon]));
      localStorage.removeItem('@paseo:settings');
      localStorage.setItem('@paseo:create-agent-preferences', JSON.stringify(preferences));
    },
    { daemon: testDaemon, preferences: createAgentPreferences }
  );
});

test.afterEach(async ({ page }, testInfo) => {
  const entries = consoleEntries.get(page);
  if (!entries || entries.length === 0) {
    return;
  }

  if (testInfo.status === testInfo.expectedStatus) {
    return;
  }

  await testInfo.attach('browser-console', {
    body: entries.join('\n'),
    contentType: 'text/plain',
  });
});

export { test, expect };
