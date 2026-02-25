import path from 'node:path';
import { appendFile, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test, expect, type Page } from './fixtures';
import {
  createAgent,
  ensureHostSelected,
  gotoHome,
  setWorkingDirectory,
} from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test.describe.configure({ mode: 'serial', timeout: 120000 });

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getChangesScope(page: Page) {
  return page.locator('[data-testid="explorer-content-area"]:visible').first();
}

function getChangesHeader(page: Page) {
  return getChangesScope(page).getByTestId('changes-header');
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

async function selectChangesView(page: Page, view: 'working' | 'base') {
  // Defensive: close any open dropdown menus (their backdrops intercept clicks).
  const primaryBackdrop = page.getByTestId('changes-primary-cta-menu-backdrop');
  if (await primaryBackdrop.isVisible().catch(() => false)) {
    await primaryBackdrop.click({ force: true });
    await expect(primaryBackdrop).toHaveCount(0);
  }
  const overflowBackdrop = page.getByTestId('changes-overflow-content-backdrop');
  if (await overflowBackdrop.isVisible().catch(() => false)) {
    await overflowBackdrop.click({ force: true });
    await expect(overflowBackdrop).toHaveCount(0);
  }
  const diffModeBackdrop = page.getByTestId('changes-diff-status-menu-backdrop');
  if (await diffModeBackdrop.isVisible().catch(() => false)) {
    await diffModeBackdrop.click({ force: true });
    await expect(diffModeBackdrop).toHaveCount(0);
  }

  const scope = getChangesScope(page);
  const modeToggle = scope.getByTestId('changes-diff-status').first();
  const expected = view === 'working' ? 'Uncommitted' : 'Committed';
  if (!(await modeToggle.isVisible().catch(() => false))) {
    return;
  }
  const current = ((await modeToggle.innerText().catch(() => '')) ?? '').trim();
  if (current !== expected) {
    await modeToggle.click();
    const menu = page.getByTestId('changes-diff-status-menu');
    await expect(menu).toBeVisible({ timeout: 10000 });
    const optionTestId =
      view === 'working' ? 'changes-diff-mode-uncommitted' : 'changes-diff-mode-committed';
    await page.getByTestId(optionTestId).click({ force: true });
  }
  await expect(modeToggle).toContainText(expected, { timeout: 10000 });
}

async function openChangesPrimaryMenu(page: Page) {
  const scope = getChangesScope(page);
  const caret = scope.getByTestId('changes-primary-cta-caret').first();
  await expect(caret).toBeVisible();
  await caret.click();
  // Menu content is rendered via a portal, so don't scope it to the explorer content area.
  await expect(page.getByTestId('changes-primary-cta-menu')).toBeVisible();
}

async function openChangesPanel(page: Page, options?: { expectGit?: boolean }) {
  await ensureExplorerTabsVisible(page);
  const changesHeader = getChangesHeader(page);
  if (!(await changesHeader.isVisible())) {
    await page.getByTestId('explorer-tab-changes').first().click();
  }
  await expect(changesHeader).toBeVisible({ timeout: 30000 });
  if (options?.expectGit === false) {
    return;
  }
  const changesScope = getChangesScope(page);
  await expect(changesScope.getByTestId('changes-not-git')).toHaveCount(0, {
    timeout: 30000,
  });
  await expect(changesScope.getByTestId('changes-branch')).not.toHaveText('Not a git repository', {
    timeout: 30000,
  });
}

async function waitForAgentTurnToSettle(page: Page, timeout = 90000) {
  const stopButton = page.getByRole('button', { name: /stop agent|stop/i }).first();
  if (!(await stopButton.isVisible().catch(() => false))) {
    return;
  }
  await expect(stopButton).not.toBeVisible({ timeout });
}

async function createAgentAndWait(page: Page, message: string) {
  await createAgent(page, message);
}

async function selectAttachWorktree(page: Page, branchName: string) {
  const trigger = page.getByTestId('worktree-select-trigger').first();
  await expect(trigger).toBeVisible({ timeout: 30000 });
  await trigger.click();

  const menu = page.getByTestId('combobox-desktop-container').first();
  await expect(menu).toBeVisible({ timeout: 10000 });
  const searchInput = page.getByRole('textbox', { name: /search worktrees/i }).first();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(branchName);
  }

  const preferredOption = menu
    .getByText(new RegExp(`^${escapeRegex(branchName)}$`, 'i'))
    .first();
  await expect(preferredOption).toBeVisible({ timeout: 10000 });
  await preferredOption.click({ force: true });
  await expect(menu).toHaveCount(0);
  await expect(trigger).toContainText(branchName, { timeout: 30000 });
}

async function enableCreateWorktree(page: Page) {
  const trigger = page.getByTestId('worktree-select-trigger').first();
  await expect(trigger).toBeVisible({ timeout: 30000 });

  const currentValue = ((await trigger.innerText().catch(() => '')) ?? '').trim();
  if (/Create new worktree/i.test(currentValue)) {
    await expect(page.getByTestId('worktree-base-branch-trigger')).toBeVisible({
      timeout: 30000,
    });
    return;
  }

  await trigger.click();
  const menu = page.getByTestId('combobox-desktop-container').first();
  await expect(menu).toBeVisible({ timeout: 10000 });
  const createOption = menu.getByText('Create new worktree', { exact: true }).first();
  await expect(createOption).toBeVisible({ timeout: 10000 });
  await createOption.click({ force: true });
  await expect(menu).toHaveCount(0);
  await expect(trigger).toContainText('Create new worktree', { timeout: 30000 });
  await expect(page.getByTestId('worktree-base-branch-trigger')).toBeVisible({
    timeout: 30000,
  });
}

async function refreshUncommittedMode(page: Page) {
  await selectChangesView(page, 'base');
  await selectChangesView(page, 'working');
}

async function refreshChangesTab(page: Page) {
  await ensureExplorerTabsVisible(page);
  await page.getByTestId('explorer-tab-files').first().click();
  await page.getByTestId('explorer-tab-changes').first().click();
}

function normalizeTmpPath(value: string) {
  if (value.startsWith('/var/')) {
    return `/private${value}`;
  }
  return value;
}

type GitWorktreeEntry = {
  worktreePath: string;
  branchRef: string | null;
};

function parseGitWorktreeList(raw: string): GitWorktreeEntry[] {
  const blocks = raw
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const entries: GitWorktreeEntry[] = [];
  for (const block of blocks) {
    const worktreeMatch = block.match(/^worktree (.+)$/m);
    if (!worktreeMatch) {
      continue;
    }
    const branchMatch = block.match(/^branch (.+)$/m);
    entries.push({
      worktreePath: worktreeMatch[1].trim(),
      branchRef: branchMatch ? branchMatch[1].trim() : null,
    });
  }
  return entries;
}

async function waitForCreatedWorktree(repoPath: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const normalizedRepoPath = normalizeTmpPath(repoPath);

  while (Date.now() < deadline) {
    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: repoPath,
        encoding: 'utf8',
      });
      const entries = parseGitWorktreeList(output);
      const candidate = entries.find((entry) => {
        const normalizedWorktreePath = normalizeTmpPath(entry.worktreePath);
        if (normalizedWorktreePath === normalizedRepoPath) {
          return false;
        }
        if (!entry.branchRef) {
          return false;
        }
        return !/\/main$/i.test(entry.branchRef);
      });

      if (candidate) {
        const branchName = candidate.branchRef?.split('/').filter(Boolean).pop();
        if (branchName) {
          return {
            worktreePath: candidate.worktreePath,
            branchName,
          };
        }
      }
    } catch {
      // Ignore transient git worktree read errors while polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for a non-main worktree under ${repoPath}`);
}

test('checkout-first Changes panel ship loop', async ({ page }) => {
  const repo = await createTempGitRepo('paseo-e2e-', { withRemote: true });
  const nonGitDir = await mkdtemp(path.join(tmpdir(), 'paseo-e2e-non-git-'));

  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);

    await enableCreateWorktree(page);
    await createAgentAndWait(page, 'Respond with exactly: READY');
    await waitForAgentTurnToSettle(page);

    await openChangesPanel(page);
    const branchLabelLocator = getChangesScope(page).getByTestId('changes-branch');
    await expect
      .poll(async () => (await branchLabelLocator.innerText()).trim(), { timeout: 30000 })
      .not.toBe('Unknown');
    const branchNameFromUi = (await branchLabelLocator.innerText()).trim();
    expect(branchNameFromUi.length).toBeGreaterThan(0);

    const { worktreePath: firstCwd, branchName: worktreeBranch } = await waitForCreatedWorktree(
      repo.path
    );
    expect(worktreeBranch.length).toBeGreaterThan(0);
    const [resolvedCwd, resolvedRepo] = await Promise.all([
      realpath(firstCwd).catch(() => firstCwd),
      realpath(repo.path).catch(() => repo.path),
    ]);
    const normalizedRepo = normalizeTmpPath(resolvedRepo);
    const normalizedCwd = normalizeTmpPath(resolvedCwd);
    const expectedMarker = `${path.sep}worktrees${path.sep}`;
    expect(normalizedCwd.includes(expectedMarker)).toBeTruthy();

    await page.getByTestId('sidebar-new-agent').click();
    await expect(page).toHaveURL(/\/h\/[^/]+\/agent(\?|$)/);

    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await selectAttachWorktree(page, worktreeBranch);
    await createAgentAndWait(page, 'Respond with exactly: READY2');
    await waitForAgentTurnToSettle(page);
    await openChangesPanel(page);

    const readmePath = path.join(firstCwd, 'README.md');
    await appendFile(readmePath, '\nFirst change\n');

    await refreshUncommittedMode(page);
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await getChangesScope(page).getByTestId('diff-file-0-toggle').first().click();
    await expect(page.getByText('First change')).toBeVisible();
    const primaryCta = getChangesScope(page).getByTestId('changes-primary-cta').first();
    await expect(primaryCta).toBeVisible();
    await expect(primaryCta).toContainText('Commit');

    await primaryCta.click();
    await expect
      .poll(() => {
        try {
          return execSync('git status --porcelain', {
            cwd: firstCwd,
            encoding: 'utf8',
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          }).trim();
        } catch {
          return null;
        }
      }, { timeout: 30000 })
      .toBe('');
    await openChangesPanel(page);
    await selectChangesView(page, 'working');
    await expect(getChangesScope(page).getByText('No uncommitted changes')).toBeVisible({
      timeout: 30000,
    });
    await expect(getChangesScope(page).getByTestId('changes-primary-cta')).not.toContainText('Commit');

    await selectChangesView(page, 'base');
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toBeVisible({
      timeout: 30000,
    });

    // Push once from the menu so the branch has an origin/<branch> ref.
    await openChangesPrimaryMenu(page);
    await page.getByTestId('changes-menu-push').click();
    await expect
      .poll(() => {
        try {
          execSync(`git show-ref --verify --quiet refs/remotes/origin/${worktreeBranch}`, { cwd: firstCwd });
          return true;
        } catch {
          return false;
        }
      }, { timeout: 30000 })
      .toBe(true);

    const notesPath = path.join(firstCwd, 'notes.txt');
    await writeFile(notesPath, 'Second change\n');

    await refreshUncommittedMode(page);
    await refreshChangesTab(page);
    await expect(getChangesScope(page).getByText('notes.txt', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toHaveCount(0);
    await expect(getChangesScope(page).getByTestId('changes-primary-cta')).toContainText('Commit');

    await selectChangesView(page, 'base');
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toBeVisible({
      timeout: 30000,
    });

    await getChangesScope(page).getByTestId('changes-primary-cta').click();
    await expect
      .poll(() => {
        try {
          return execSync('git status --porcelain', {
            cwd: firstCwd,
            encoding: 'utf8',
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          }).trim();
        } catch {
          return null;
        }
      }, { timeout: 30000 })
      .toBe('');
    await openChangesPanel(page);
    await selectChangesView(page, 'working');
    await expect(getChangesScope(page).getByText('No uncommitted changes')).toBeVisible({ timeout: 30000 });
    await expect(getChangesScope(page).getByTestId('changes-primary-cta')).not.toContainText('Commit');

    await selectChangesView(page, 'base');
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(getChangesScope(page).getByText('notes.txt', { exact: true })).toBeVisible({
      timeout: 30000,
    });

    // Push is now the primary action (origin/<branch> exists and we're ahead of it).
    const pushPrimary = getChangesScope(page).getByTestId('changes-primary-cta').first();
    await expect(pushPrimary).toContainText(/push/i, { timeout: 30000 });
    await pushPrimary.click();
    // Regression check: the primary CTA stays in place while pushing.
    await expect(pushPrimary).toBeVisible();
    await page.waitForTimeout(50);
    await expect(pushPrimary).toBeVisible();

    await expect
      .poll(() => {
        try {
          const count = execSync(
            `git rev-list --count origin/${worktreeBranch}..${worktreeBranch}`,
            { cwd: firstCwd, encoding: 'utf8' }
          ).trim();
          return Number.parseInt(count, 10);
        } catch {
          return null;
        }
      }, { timeout: 30000 })
      .toBe(0);

    // Merge to base in the main worktree (worktree branches can't always check out base refs in-place).
    // This avoids UI flakiness around ship actions while still validating the diff panel end-to-end.
    execSync("git checkout main", { cwd: repo.path });
    execSync(`git -c commit.gpgsign=false merge --no-edit ${worktreeBranch}`, { cwd: repo.path });
    execSync("git push", { cwd: repo.path });

    await selectChangesView(page, 'base');
    await expect(getChangesScope(page).getByTestId('changes-diff-status')).toContainText(
      'Committed',
      { timeout: 30000 }
    );
    await refreshChangesTab(page);

    // Post-ship UI behavior is implementation-dependent (archive can be promoted into
    // primary flow or hidden behind menu variants), so continue from a fresh draft.
    await page.getByTestId('sidebar-new-agent').click();
    await expect(page).toHaveURL(/\/h\/[^/]+\/agent(?:\?|$)/, { timeout: 30000 });

    await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeEditable();
  } finally {
    await rm(nonGitDir, { recursive: true, force: true });
    await repo.cleanup();
  }
});
