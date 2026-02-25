import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { test, expect, type Page } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test.describe.configure({ timeout: 90000 });

function getChangesScope(page: Page) {
  return page.locator('[data-testid="explorer-content-area"]:visible').first();
}

async function ensureExplorerTabsVisible(page: Page) {
  const changesTab = page.getByTestId('explorer-tab-changes').first();
  if (await changesTab.isVisible().catch(() => false)) {
    return;
  }

  const toggle = page
    .getByRole('button', { name: /open explorer|close explorer|toggle explorer/i })
    .first();
  await expect(toggle).toBeVisible({ timeout: 10000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await changesTab.isVisible().catch(() => false)) {
      return;
    }
    await toggle.click();
    await page.waitForTimeout(200);
  }
  await expect(changesTab).toBeVisible({ timeout: 30000 });
}

async function openChangesPanel(page: Page) {
  await ensureExplorerTabsVisible(page);
  const changesHeader = getChangesScope(page).getByTestId('changes-header');
  if (!(await changesHeader.isVisible())) {
    await page.getByTestId('explorer-tab-changes').first().click();
  }
  await expect(changesHeader).toBeVisible();
}

async function refreshUncommittedMode(page: Page) {
  const scope = getChangesScope(page);
  const toggle = scope.getByTestId('changes-diff-status').first();
  await expect(toggle).toBeVisible({ timeout: 30000 });

  const diffModeBackdrop = page.getByTestId('changes-diff-status-menu-backdrop');
  if (await diffModeBackdrop.isVisible().catch(() => false)) {
    await diffModeBackdrop.click({ force: true });
    await expect(diffModeBackdrop).toHaveCount(0);
  }

  const currentLabel = (await toggle.innerText()).trim();
  await toggle.click({ force: true });
  await expect(page.getByTestId('changes-diff-status-menu')).toBeVisible({ timeout: 10000 });
  const firstTarget = currentLabel === 'Uncommitted' ? 'changes-diff-mode-committed' : 'changes-diff-mode-uncommitted';
  await page.getByTestId(firstTarget).click({ force: true });
  await expect.poll(async () => (await toggle.innerText()).trim()).not.toBe(currentLabel);

  const nextLabel = (await toggle.innerText()).trim();
  await toggle.click({ force: true });
  await expect(page.getByTestId('changes-diff-status-menu')).toBeVisible({ timeout: 10000 });
  const secondTarget = nextLabel === 'Uncommitted' ? 'changes-diff-mode-committed' : 'changes-diff-mode-uncommitted';
  await page.getByTestId(secondTarget).click({ force: true });
  await expect.poll(async () => (await toggle.innerText()).trim()).not.toBe(nextLabel);
}

async function createAgentAndWait(page: Page, message: string) {
  await createAgent(page, message);
}

test('keeps file header sticky while scrolling within a long diff', async ({ page }) => {
  const repo = await createTempGitRepo('paseo-e2e-sticky-');

  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgentAndWait(page, 'Respond with exactly: READY');

    await openChangesPanel(page);

    const readmePath = path.join(repo.path, 'README.md');
    const lines = Array.from({ length: 400 }, (_, idx) => `Sticky header line ${idx}\n`).join('');
    await appendFile(readmePath, `\n${lines}`);

    await refreshUncommittedMode(page);

    const scope = getChangesScope(page);
    await expect(scope.getByText('README.md', { exact: true })).toBeVisible({ timeout: 30000 });

    const fileToggle = scope.getByTestId('diff-file-0-toggle').first();
    await fileToggle.click();

    const markerLine = scope.getByText('Sticky header line 250').first();
    await expect(markerLine).toBeVisible({ timeout: 30000 });

    const scroll = scope.getByTestId('git-diff-scroll').first();
    await expect(scroll).toBeVisible();

    await expect.poll(async () => {
      return await scroll.evaluate((el) => (el.scrollHeight ?? 0) > (el.clientHeight ?? 0));
    }).toBe(true);

    await scroll.hover();
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 700);
    }

    await expect.poll(async () => {
      return await scroll.evaluate((el) => el.scrollTop ?? 0);
    }).toBeGreaterThan(0);

    await expect(scope.getByText('Sticky header line 390').first()).toBeVisible({ timeout: 30000 });
    await expect(fileToggle).toBeVisible();
  } finally {
    await repo.cleanup();
  }
});
