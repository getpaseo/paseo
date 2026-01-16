import { test, expect, type Page } from '@playwright/test';

const consoleEntries = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const entries: string[] = [];
  consoleEntries.set(page, entries);

  page.on('console', (message) => {
    entries.push(`[console:${message.type()}] ${message.text()}`);
  });

  page.on('pageerror', (error) => {
    entries.push(`[pageerror] ${error.message}`);
  });

  // Set up test daemon connection if available
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (daemonPort) {
    const testDaemon = {
      id: 'e2e-test-daemon',
      label: 'localhost',
      wsUrl: `ws://localhost:${daemonPort}/ws`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await page.addInitScript((daemon) => {
      localStorage.setItem('@paseo:daemon-registry', JSON.stringify([daemon]));
    }, testDaemon);
  }
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
