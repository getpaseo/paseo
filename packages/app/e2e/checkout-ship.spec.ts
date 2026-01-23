import path from 'node:path';
import { appendFile, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, expect, type Page } from './fixtures';
import {
  allowPermission,
  ensureHostSelected,
  gotoHome,
  setWorkingDirectory,
  waitForPermissionPrompt,
} from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

test.describe.configure({ mode: 'serial', timeout: 120000 });

function getChangesScope(page: Page) {
  return page.locator('[data-testid="explorer-content-area"]:visible').first();
}

function getChangesHeader(page: Page) {
  return getChangesScope(page).getByTestId('changes-header');
}

function getChangesActionLabel(page: Page, label: string) {
  return getChangesScope(page).getByText(label, { exact: true });
}

function getChangesActionButton(page: Page, label: string) {
  return getChangesActionLabel(page, label).locator('..');
}

async function openChangesOverflowMenu(page: Page) {
  const menuButton = page.getByTestId('changes-overflow-menu').first();
  await expect(menuButton).toBeVisible();
  await menuButton.click();
}

async function openChangesPanel(page: Page, options?: { expectGit?: boolean }) {
  const changesHeader = getChangesHeader(page);
  if (!(await changesHeader.isVisible())) {
    const explorerHeader = page.getByTestId('explorer-header');
    if (await explorerHeader.isVisible()) {
      await page.getByText('Changes', { exact: true }).click();
    } else {
      const overflowMenu = page.getByTestId('agent-overflow-menu').first();
      await expect(overflowMenu).toBeVisible({ timeout: 10000 });
      await overflowMenu.click();
      await page.getByText('View Changes', { exact: true }).click();
    }
  }
  await expect(changesHeader).toBeVisible();
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

async function waitForAssistantTextWithPermissions(
  page: Page,
  text: string,
  timeoutMs = 60000
) {
  const start = Date.now();
  const assistantMessage = page
    .getByTestId('assistant-message')
    .filter({ hasText: text })
    .last();
  while (Date.now() - start < timeoutMs) {
    if (await assistantMessage.isVisible()) {
      return assistantMessage;
    }
    const allowButton = page.getByText('Allow', { exact: true }).first();
    if (await allowButton.isVisible()) {
      try {
        await allowButton.click({ force: true, timeout: 1000 });
      } catch {
        // Button can detach during animation; retry on next loop.
      }
      continue;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for assistant text: ${text}`);
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
  const option = scope.getByText(branchName, { exact: true }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(picker).toContainText(branchName);
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
  const changesScope = getChangesScope(page);
  await changesScope.getByTestId('changes-mode-base').click();
  await changesScope.getByTestId('changes-mode-uncommitted').click();
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
    const branchName = (await getChangesScope(page).getByTestId('changes-branch').innerText()).trim();
    expect(branchName.length).toBeGreaterThan(0);

    const firstCwd = await requestCwd(page);
    const [resolvedCwd, resolvedRepo] = await Promise.all([
      realpath(firstCwd).catch(() => firstCwd),
      realpath(repo.path).catch(() => repo.path),
    ]);
    const normalizedRepo = normalizeTmpPath(resolvedRepo);
    const normalizedCwd = normalizeTmpPath(resolvedCwd);
    const expectedRoot = path.join(normalizedRepo, '.paseo', 'worktrees');
    const expectedRootRaw = normalizeTmpPath(
      path.join(repo.path, '.paseo', 'worktrees')
    );
    expect(
      normalizedCwd.startsWith(expectedRoot) ||
        normalizedCwd.startsWith(expectedRootRaw)
    ).toBeTruthy();

    await page.getByTestId('sidebar-new-agent').click();
    await expect(page).toHaveURL(/\/$/);

    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await selectAttachWorktree(page, branchName);
    await createAgentAndWait(page, 'Respond with exactly: READY2');
    await waitForAssistantText(page, 'READY2');

    const secondCwd = await requestCwd(page);
    expect(secondCwd).toBe(firstCwd);

    await sendPrompt(
      page,
      'Only call MCP tools set_title("E2E Ship Loop") and set_branch("feat/e2e-ship-loop"). Do not run bash or other tools. Then respond with exactly: OK'
    );
    await waitForAssistantTextWithPermissions(page, 'OK', 60000);
    await expect(page.getByText('E2E Ship Loop', { exact: true }).first()).toBeVisible();

    await openChangesPanel(page);
    await expect.poll(
      async () => (await getChangesScope(page).getByTestId('changes-branch').innerText()).trim(),
      { timeout: 60000 }
    ).toBe('feat/e2e-ship-loop');

    const readmePath = path.join(firstCwd, 'README.md');
    await appendFile(readmePath, '\nFirst change\n');

    await refreshUncommittedMode(page);
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await getChangesScope(page).getByTestId('diff-file-0-toggle').first().click();
    await expect(page.getByText('First change')).toBeVisible();
    await expect(getChangesActionLabel(page, 'Commit')).toBeVisible();

    await getChangesActionButton(page, 'Commit').click();
    await getChangesScope(page).getByTestId('changes-mode-uncommitted').click();
    await refreshChangesTab(page);
    await expect(getChangesScope(page).getByText('No uncommitted changes')).toBeVisible({
      timeout: 30000,
    });
    await expect(getChangesActionLabel(page, 'Commit')).toHaveCount(0);

    await getChangesScope(page).getByTestId('changes-mode-base').click();
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toBeVisible({
      timeout: 30000,
    });

    const notesPath = path.join(firstCwd, 'notes.txt');
    await writeFile(notesPath, 'Second change\n');

    await refreshUncommittedMode(page);
    await refreshChangesTab(page);
    await expect(getChangesScope(page).getByText('notes.txt', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toHaveCount(0);
    await expect(getChangesActionLabel(page, 'Commit')).toBeVisible();

    await getChangesScope(page).getByTestId('changes-mode-base').click();
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toBeVisible({
      timeout: 30000,
    });

    await getChangesActionButton(page, 'Commit').click();
    await getChangesScope(page).getByTestId('changes-mode-uncommitted').click();
    await expect(page.getByText('No uncommitted changes')).toBeVisible({ timeout: 30000 });
    await expect(getChangesActionLabel(page, 'Commit')).toHaveCount(0);

    await getChangesScope(page).getByTestId('changes-mode-base').click();
    await expect(getChangesScope(page).getByText('README.md', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(getChangesScope(page).getByText('notes.txt', { exact: true })).toBeVisible({
      timeout: 30000,
    });

    await expect(getChangesActionLabel(page, 'Create PR')).toBeVisible();
    await getChangesActionButton(page, 'Create PR').click();
    await expect(getChangesScope(page).getByTestId('changes-pr-status')).toContainText(/open/i, {
      timeout: 60000,
    });
    await expect(getChangesActionLabel(page, 'Create PR')).toHaveCount(0);

    await getChangesActionButton(page, 'Merge to base').click();
    await getChangesScope(page).getByTestId('changes-mode-base').click();
    await expect(getChangesScope(page).getByText('No base changes')).toBeVisible({
      timeout: 60000,
    });
    await refreshChangesTab(page);
    await expect(getChangesActionLabel(page, 'Merge to base')).toHaveCount(0, { timeout: 30000 });

    await openChangesOverflowMenu(page);
    await expect(page.getByTestId('changes-menu-archive')).toBeVisible();
    await page.getByTestId('changes-menu-archive').click();
    // Archiving a worktree deletes agents and redirects to home
    await expect(page).toHaveURL(/\/$/, { timeout: 30000 });
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await page.getByTestId('worktree-attach-toggle').click();
    await page.getByTestId('worktree-attach-picker').click();
    await expect(page.getByText(branchName, { exact: true })).toHaveCount(0);
    const attachSheetBackdrop = page.getByRole('button', { name: 'Bottom sheet backdrop' });
    if (await attachSheetBackdrop.isVisible()) {
      await attachSheetBackdrop.click({ force: true });
    }
    await page.getByTestId('worktree-attach-toggle').click();
    await expect(page.getByTestId('worktree-attach-picker')).toHaveCount(0);

    await setWorkingDirectory(page, nonGitDir);
    const attachPicker = page.getByTestId('worktree-attach-picker');
    if (await attachPicker.isVisible()) {
      await page.getByTestId('worktree-attach-toggle').click();
      await expect(attachPicker).toHaveCount(0);
    }
    await createAgentAndWait(page, 'Respond with exactly: NON-GIT');
    await waitForAssistantText(page, 'NON-GIT');
    await openChangesPanel(page, { expectGit: false });
    await expect(getChangesScope(page).getByTestId('changes-not-git')).toBeVisible();
    await expect(getChangesScope(page).getByTestId('changes-toolbar')).toHaveCount(0);
  } finally {
    await rm(nonGitDir, { recursive: true, force: true });
    await repo.cleanup();
  }
});
