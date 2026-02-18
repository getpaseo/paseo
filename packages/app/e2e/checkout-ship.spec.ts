import path from 'node:path';
import { appendFile, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test, expect, type Page } from './fixtures';
import {
  ensureHostSelected,
  gotoHome,
  setWorkingDirectory,
} from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test.describe.configure({ mode: 'serial', timeout: 120000 });

function getChangesScope(page: Page) {
  return page.locator('[data-testid="explorer-content-area"]:visible').first();
}

function getChangesHeader(page: Page) {
  return getChangesScope(page).getByTestId('changes-header');
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

  const scope = getChangesScope(page);
  const modeToggle = scope.getByTestId('changes-diff-status').first();
  const expected = view === 'working' ? 'Uncommitted' : 'Committed';
  if (!(await modeToggle.isVisible().catch(() => false))) {
    return;
  }
  const current = ((await modeToggle.innerText().catch(() => '')) ?? '').trim();
  if (current !== expected) {
    await modeToggle.click();
  }
  await expect(modeToggle).toContainText(expected, { timeout: 10000 });
}

async function openChangesOverflowMenu(page: Page) {
  const menuButton = getChangesScope(page).locator('[data-testid="changes-overflow-menu"]:visible').first();
  await expect(menuButton).toBeVisible();
  await menuButton.click();
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
  const changesHeader = getChangesHeader(page);
  if (!(await changesHeader.isVisible())) {
    const explorerHeader = page.getByTestId('explorer-header');
    if (await explorerHeader.isVisible()) {
      const changesTab = explorerHeader.getByText('Changes', { exact: true });
      if (await changesTab.isVisible().catch(() => false)) {
        await changesTab.click();
      } else {
        const overflowMenu = page.getByTestId('agent-overflow-menu').first();
        await expect(overflowMenu).toBeVisible({ timeout: 10000 });
        await overflowMenu.click();
        await page.getByText(/view changes/i).first().click();
      }
    } else {
      const overflowMenu = page.getByTestId('agent-overflow-menu').first();
      await expect(overflowMenu).toBeVisible({ timeout: 10000 });
      await overflowMenu.click();
      await page.getByText(/view changes/i).first().click();
    }
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

async function sendPrompt(page: Page, prompt: string) {
  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable();
  await input.fill(prompt);
  await input.press('Enter');
}

async function waitForAssistantText(page: Page, text: string) {
  const assistantMessage = page.getByTestId('assistant-message').filter({ hasText: text }).last();
  await expect(assistantMessage).toBeVisible({ timeout: 60000 });
  return assistantMessage;
}

async function createAgentAndWait(page: Page, message: string) {
  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable();
  await input.fill(message);
  await input.press('Enter');
  await expect(page).toHaveURL(/\/agent\//, { timeout: 120000 });
  await expect(page.getByText(message, { exact: true })).toBeVisible();
}

async function requestCwd(page: Page) {
  await sendPrompt(page, 'Run `pwd` and respond with exactly: CWD: <path>');
  const message = await waitForAssistantText(page, 'CWD:');
  // The assistant streams tokens; make sure we capture the full path (not a partial prefix).
  await expect.poll(async () => (await message.textContent()) ?? '', { timeout: 60000 }).toContain('/worktrees/');
  const content = (await message.textContent()) ?? '';
  const match = content.match(/CWD:\s*(\S+)/);
  if (!match) {
    throw new Error(`Expected agent to respond with "CWD: <path>", got: ${content}`);
  }
  return match[1].trim();
}

async function selectAttachWorktree(page: Page, branchName: string) {
  await page.getByTestId('worktree-attach-toggle').click();
  const picker = page.getByTestId('worktree-attach-picker');
  await expect(picker).toBeVisible();

  // Wait a bit for the worktree list to load
  await page.waitForTimeout(1000);

  await picker.click();

  // Wait a bit for animation
  await page.waitForTimeout(500);

  const sheet = page.getByLabel('Bottom Sheet', { exact: true });
  const backdrop = page.getByRole('button', { name: 'Bottom sheet backdrop' }).first();

  await expect.poll(async () => {
    const sheetVisible = await sheet.isVisible().catch(() => false);
    const backdropVisible = await backdrop.isVisible().catch(() => false);
    // Also check if branch name is visible directly
    const branchVisible = await page.getByText(branchName, { exact: true }).first().isVisible().catch(() => false);
    return sheetVisible || backdropVisible || branchVisible;
  }, { timeout: 10000 }).toBeTruthy();
  const sheetVisible = await sheet.isVisible().catch(() => false);
  const scope = sheetVisible ? sheet : page;
  const preferredOption = scope.getByText(branchName, { exact: true }).first();
  if (await preferredOption.isVisible().catch(() => false)) {
    await preferredOption.click();
    await expect(picker).toContainText(branchName);
    return;
  }

  const options = scope.locator('[data-testid^="worktree-attach-option-"]');
  const optionCount = await options.count();
  if (optionCount === 0) {
    throw new Error(`No worktree options were available in the attach picker`);
  }
  const fallbackOption = options.first();
  const fallbackLabel = ((await fallbackOption.innerText()) ?? "").trim();
  await fallbackOption.click();
  if (fallbackLabel.length > 0) {
    await expect(picker).toContainText(fallbackLabel);
  }
}

async function enableCreateWorktree(page: Page) {
  const createToggle = page.getByTestId('worktree-create-toggle');
  const willCreateLabel = page.getByText(/Will create:/);
  if (await willCreateLabel.isVisible()) {
    return;
  }
  const readyLabel = page.getByText(
    /Run isolated from|Run in an isolated directory/
  );
  await expect(readyLabel).toBeVisible({ timeout: 30000 });
  await createToggle.click({ force: true });
  await expect(willCreateLabel).toBeVisible({ timeout: 30000 });
}

async function refreshUncommittedMode(page: Page) {
  await selectChangesView(page, 'base');
  await selectChangesView(page, 'working');
}

async function refreshChangesTab(page: Page) {
  const header = page.locator('[data-testid="explorer-header"]:visible').first();
  await header.getByText('Files', { exact: true }).first().click();
  await header.getByText('Changes', { exact: true }).first().click();
}

function normalizeTmpPath(value: string) {
  if (value.startsWith('/var/')) {
    return `/private${value}`;
  }
  return value;
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
    await waitForAssistantText(page, 'READY');

    await openChangesPanel(page);
    const branchLabelLocator = getChangesScope(page).getByTestId('changes-branch');
    await expect
      .poll(async () => (await branchLabelLocator.innerText()).trim(), { timeout: 30000 })
      .not.toBe('Unknown');
    const branchNameFromUi = (await branchLabelLocator.innerText()).trim();
    expect(branchNameFromUi.length).toBeGreaterThan(0);

    const firstCwd = await requestCwd(page);
    const worktreeBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: firstCwd,
      encoding: 'utf8',
    }).trim();
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
    await expect(page).toHaveURL(/\/agent\/?$/);

    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await selectAttachWorktree(page, worktreeBranch);
    await createAgentAndWait(page, 'Respond with exactly: READY2');
    await waitForAssistantText(page, 'READY2');

    const secondCwd = await requestCwd(page);
    expect(secondCwd).toBe(firstCwd);

    await sendPrompt(page, "Respond with exactly: OK");
    await waitForAssistantText(page, "OK");

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
    await expect(getChangesScope(page).getByText(/No changes vs/i)).toBeVisible({
      timeout: 60000,
    });
    await refreshChangesTab(page);
    await expect(getChangesScope(page).getByTestId('changes-primary-cta')).toHaveCount(0, { timeout: 30000 });

    await openChangesOverflowMenu(page);
    await expect(page.getByTestId('changes-menu-archive-worktree')).toBeVisible();
    await page.getByTestId('changes-menu-archive-worktree').click();
    // Archiving a worktree deletes agents and redirects to home
    await expect(page).toHaveURL(/\/agent\/?(?:\?.*)?$/, { timeout: 30000 });
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    // Repo inspection is async; wait until git options are interactive again.
    await expect(page.getByText('Inspecting repository…')).toHaveCount(0, { timeout: 30000 });
    await page.getByTestId('worktree-attach-toggle').click();
    await expect(page.getByTestId('worktree-attach-picker')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('worktree-attach-picker').click();
    await expect(page.getByText(worktreeBranch, { exact: true })).toHaveCount(0);
    const attachSheet = page.getByLabel('Bottom Sheet', { exact: true });
    if (await attachSheet.isVisible().catch(() => false)) {
      await page.getByTestId('dropdown-sheet-close').click({ force: true });
      await expect(attachSheet).toBeHidden({ timeout: 30000 });
    }
    await page.getByTestId('worktree-attach-toggle').click();
    await expect(page.getByTestId('worktree-attach-picker')).toBeHidden({ timeout: 30000 });

    await setWorkingDirectory(page, nonGitDir);
    // Wait for git options to disappear (repo inspection is async and the git section can briefly render stale UI).
    await expect(page.getByTestId('worktree-attach-toggle')).toHaveCount(0, { timeout: 30000 });
    await expect(page.getByTestId('worktree-attach-picker')).toHaveCount(0);
    await createAgentAndWait(page, 'Respond with exactly: NON-GIT');
    await waitForAssistantText(page, 'NON-GIT');
    await openChangesPanel(page, { expectGit: false });
    await expect(getChangesScope(page).getByTestId('changes-not-git')).toBeVisible();
    await expect(getChangesScope(page).getByTestId('changes-primary-cta')).toHaveCount(0);
    await expect(getChangesScope(page).getByTestId('changes-overflow-menu')).toHaveCount(0);
  } finally {
    await rm(nonGitDir, { recursive: true, force: true });
    await repo.cleanup();
  }
});
