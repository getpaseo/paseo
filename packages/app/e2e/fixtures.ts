import { test, expect, type Page } from '@playwright/test';

const consoleEntries = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const entries: string[] = [];
  consoleEntries.set(page, entries);

  page.on('console', (message) => {
    entries.push(`[console:${message.type()}] ${message.text()}`);
  });

  page.on('pageerror', (error) => {
    entries.push(`[pageerror] ${error.message}`);
  });
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
