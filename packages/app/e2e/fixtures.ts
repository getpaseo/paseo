import { test as base, expect, type Page } from '@playwright/test';

// Extend base test to provide dynamic baseURL from global-setup
const test = base.extend({
  baseURL: async ({}, use) => {
    const metroPort = process.env.E2E_METRO_PORT;
    if (!metroPort) {
      throw new Error('E2E_METRO_PORT not set - globalSetup must run first');
    }
    await use(`http://localhost:${metroPort}`);
  },
});

const consoleEntries = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  const metroPort = process.env.E2E_METRO_PORT;
  if (!daemonPort) {
    throw new Error(
      'E2E_DAEMON_PORT is not set. Refusing to run e2e against the default daemon (e.g. localhost:6767). ' +
        'Ensure Playwright `globalSetup` starts the e2e daemon and exports E2E_DAEMON_PORT.'
    );
  }
  if (daemonPort === '6767') {
    throw new Error(
      'E2E_DAEMON_PORT is 6767. Refusing to run e2e against the default local daemon. ' +
        'Fix Playwright globalSetup to start an isolated test daemon and export its port.'
    );
  }
  if (!metroPort) {
    throw new Error(
      'E2E_METRO_PORT is not set. Ensure Playwright `globalSetup` starts Metro and exports E2E_METRO_PORT.'
    );
  }

  // Hard guardrail: never allow tests to hit the developer's default daemon.
  // This blocks both HTTP and WS attempts to :6767 (before any navigation).
  await page.route(/:(6767)\b/, (route) => route.abort());
  await page.routeWebSocket(/:(6767)\b/, async (ws) => {
    await ws.close({ code: 1008, reason: 'Blocked connection to localhost:6767 during e2e.' });
  });

  const entries: string[] = [];
  consoleEntries.set(page, entries);

  page.on('console', (message) => {
    entries.push(`[console:${message.type()}] ${message.text()}`);
  });

  page.on('pageerror', (error) => {
    entries.push(`[pageerror] ${error.message}`);
  });

  const nowIso = new Date().toISOString();
  const seedNonce = Math.random().toString(36).slice(2);
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error('E2E_SERVER_ID is not set - expected from Playwright globalSetup.');
  }
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
    // Ensure create flow never uses a remembered host from the developer's real app.
    serverId: testDaemon.serverId,
    // Keep e2e fast/cheap by default.
    provider: 'claude',
    providerPreferences: {
      claude: { model: 'haiku' },
      codex: { model: 'gpt-5.1-codex-mini' },
    },
  };

  await page.addInitScript(
    ({ daemon, preferences, seedNonce }) => {
      // `addInitScript` runs on every navigation (including reloads). Some tests intentionally
      // override storage and reload; they can opt out of seeding for the *next* navigation by
      // setting this flag before the reload.
      const disableOnceKey = '@paseo:e2e-disable-default-seed-once';
      const disableValue = localStorage.getItem(disableOnceKey);
      if (disableValue) {
        localStorage.removeItem(disableOnceKey);
        if (disableValue === seedNonce) {
          return;
        }
      }

      localStorage.setItem('@paseo:e2e', '1');
      localStorage.setItem('@paseo:e2e-seed-nonce', seedNonce);

      // Hard-reset anything that could point to a developer's real daemon.
      localStorage.setItem('@paseo:daemon-registry', JSON.stringify([daemon]));
      localStorage.removeItem('@paseo:settings');
      localStorage.setItem('@paseo:create-agent-preferences', JSON.stringify(preferences));
    },
    { daemon: testDaemon, preferences: createAgentPreferences, seedNonce }
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

export { test, expect, type Page };
