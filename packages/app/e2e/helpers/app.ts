import { expect, type Page } from '@playwright/test';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getE2EDaemonPort(): string {
  const port = process.env.E2E_DAEMON_PORT;
  if (!port) {
    throw new Error('E2E_DAEMON_PORT is not set (expected from Playwright globalSetup).');
  }
  if (port === '6767') {
    throw new Error('E2E_DAEMON_PORT is 6767. Refusing to run e2e against the default local daemon.');
  }
  return port;
}

async function ensureE2EStorageSeeded(page: Page): Promise<void> {
  const port = getE2EDaemonPort();
  const expectedEndpoint = `127.0.0.1:${port}`;
  const expectedServerId = process.env.E2E_SERVER_ID;
  if (!expectedServerId) {
    throw new Error('E2E_SERVER_ID is not set (expected from Playwright globalSetup).');
  }

  const needsReset = await page.evaluate(({ expectedEndpoint, expectedServerId }) => {
    const raw = localStorage.getItem('@paseo:daemon-registry');
    if (!raw) return true;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length !== 1) return true;
      const entry = parsed[0] as any;
      if (entry?.serverId !== expectedServerId) return true;
      const connections = entry?.connections;
      if (!Array.isArray(connections)) return true;
      if (connections.some((c: any) => c?.type === 'direct' && typeof c?.endpoint === 'string' && /:6767\b/.test(c.endpoint))) return true;
      return !connections.some((c: any) => c?.type === 'direct' && c?.endpoint === expectedEndpoint);
    } catch {
      return true;
    }
  }, { expectedEndpoint, expectedServerId });

  if (!needsReset) {
    return;
  }

  const nowIso = new Date().toISOString();
  await page.evaluate(
    ({ expectedEndpoint, nowIso, expectedServerId }) => {
      localStorage.setItem('@paseo:e2e', '1');
      localStorage.setItem(
        '@paseo:daemon-registry',
        JSON.stringify([
          {
            serverId: expectedServerId,
            label: 'localhost',
            connections: [
              {
                id: `direct:${expectedEndpoint}`,
                type: 'direct',
                endpoint: expectedEndpoint,
              },
            ],
            preferredConnectionId: `direct:${expectedEndpoint}`,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ])
      );
      localStorage.setItem(
        '@paseo:create-agent-preferences',
        JSON.stringify({
          serverId: expectedServerId,
          provider: 'claude',
          providerPreferences: {
            claude: { model: 'haiku' },
            codex: { model: 'gpt-5.1-codex-mini' },
          },
        })
      );
      localStorage.removeItem('@paseo:settings');
    },
    { expectedEndpoint, nowIso, expectedServerId }
  );

  await page.reload();
}

async function assertE2EUsesSeededTestDaemon(page: Page): Promise<void> {
  const port = getE2EDaemonPort();
  const expectedEndpoint = `127.0.0.1:${port}`;
  const expectedServerId = process.env.E2E_SERVER_ID;
  if (!expectedServerId) {
    throw new Error('E2E_SERVER_ID is not set (expected from Playwright globalSetup).');
  }

  const snapshot = await page.evaluate(() => {
    const registryRaw = localStorage.getItem('@paseo:daemon-registry');
    const prefsRaw = localStorage.getItem('@paseo:create-agent-preferences');
    return { registryRaw, prefsRaw };
  });

  if (!snapshot.registryRaw) {
    throw new Error('E2E expected @paseo:daemon-registry to be set before app load.');
  }

  let registry: any;
  try {
    registry = JSON.parse(snapshot.registryRaw);
  } catch {
    throw new Error('E2E expected @paseo:daemon-registry to be valid JSON.');
  }

  if (!Array.isArray(registry) || registry.length !== 1) {
    throw new Error(
      `E2E expected @paseo:daemon-registry to contain exactly 1 daemon (got ${Array.isArray(registry) ? registry.length : 'non-array'}).`
    );
  }

  const daemon = registry[0];
  if (typeof daemon?.serverId !== 'string' || daemon.serverId.length === 0) {
    throw new Error(`E2E expected seeded daemon to have a string serverId (got ${String(daemon?.serverId)}).`);
  }
  if (daemon.serverId !== expectedServerId) {
    throw new Error(`E2E expected seeded daemon serverId to be ${expectedServerId} (got ${daemon.serverId}).`);
  }

  const connections: unknown = daemon?.connections;
  if (
    !Array.isArray(connections) ||
    !connections.some((c: any) => c?.type === 'direct' && c?.endpoint === expectedEndpoint)
  ) {
    throw new Error(
      `E2E expected seeded daemon connections to include direct ${expectedEndpoint} (got ${JSON.stringify(connections)}).`
    );
  }
  if (Array.isArray(connections) && connections.some((c: any) => c?.type === 'direct' && typeof c?.endpoint === 'string' && /:6767\b/.test(c.endpoint))) {
    throw new Error(`E2E detected a daemon endpoint pointing at :6767 (${JSON.stringify(connections)}).`);
  }

  if (!snapshot.prefsRaw) {
    throw new Error('E2E expected @paseo:create-agent-preferences to be set before app load.');
  }
  try {
    const prefs = JSON.parse(snapshot.prefsRaw) as any;
    if (prefs?.serverId !== daemon.serverId) {
      throw new Error(
        `E2E expected create-agent-preferences.serverId to match seeded daemon serverId (${daemon.serverId}) (got ${String(prefs?.serverId)}).`
      );
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('E2E expected @paseo:create-agent-preferences to be valid JSON.');
  }
}

export const gotoHome = async (page: Page) => {
  await page.goto('/');
  await ensureE2EStorageSeeded(page);
  await expect(page.getByText('New agent', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeVisible();
};

export const openSettings = async (page: Page) => {
  // Navigate directly to settings page
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings$/);
};

export const setWorkingDirectory = async (page: Page, directory: string) => {
  const workingDirectoryLabel = page.getByText('WORKING DIRECTORY', { exact: true }).first();
  await expect(workingDirectoryLabel).toBeVisible();
  const workingDirectorySelect = page.getByTestId('working-directory-select').first();

  const input = page.getByRole('textbox', { name: '/path/to/project' });
  const worktreePicker = page.getByTestId('worktree-attach-picker');
  const worktreeSheetTitle = page.getByText('Select worktree', { exact: true });
  const closeBottomSheet = async () => {
    const bottomSheetBackdrop = page
      .getByRole('button', { name: 'Bottom sheet backdrop' })
      .first();
    const bottomSheetHandle = page
      .getByRole('slider', { name: 'Bottom sheet handle' })
      .first();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await bottomSheetBackdrop.isVisible())) {
        return;
      }
      await bottomSheetBackdrop.click({ force: true });
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(200);
    }
    if (await bottomSheetBackdrop.isVisible()) {
      const box = await bottomSheetHandle.boundingBox();
      if (box) {
        const startX = box.x + box.width / 2;
        const startY = box.y + box.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX, startY + 400);
        await page.mouse.up();
        await page.waitForTimeout(200);
      }
    }
  };
  const closeWorktreeSheetIfOpen = async () => {
    if (!(await worktreeSheetTitle.isVisible()) && !(await worktreePicker.isVisible())) {
      return;
    }
    const attachToggle = page.getByTestId('worktree-attach-toggle');
    if (await attachToggle.isVisible()) {
      await attachToggle.click({ force: true });
      await page.waitForTimeout(200);
    }
    await closeBottomSheet();
  };

  await closeWorktreeSheetIfOpen();

  if (!(await input.isVisible())) {
    await closeBottomSheet();
    await workingDirectorySelect.click({ force: true });
    if (!(await input.isVisible())) {
      await closeBottomSheet();
      await workingDirectorySelect.click({ force: true });
    }
    await expect(input).toBeVisible();
  }

  const trimmedDirectory = directory.replace(/\/+$/, '');
  await input.fill(trimmedDirectory);
  await input.press('Enter');

  // Desktop web supports selecting via Enter; mobile may require clicking the explicit option.
  const useOption = page.getByTestId('working-directory-custom-option').first();
  if (await useOption.isVisible().catch(() => false)) {
    await expect(useOption).toContainText(`Use "${trimmedDirectory}"`);
    await useOption.click({ force: true });
  }

  // Wait for the sheet to close after clicking "Use"
  await expect(input).not.toBeVisible({ timeout: 10000 });

  const directoryCandidates = new Set<string>([trimmedDirectory]);
  if (trimmedDirectory.startsWith('/var/')) {
    directoryCandidates.add(`/private${trimmedDirectory}`);
  }
  if (trimmedDirectory.startsWith('/private/var/')) {
    directoryCandidates.add(trimmedDirectory.replace(/^\/private/, ''));
  }
  const basename = trimmedDirectory.split('/').filter(Boolean).pop() ?? trimmedDirectory;

  await expect.poll(async () => {
    const text = await workingDirectorySelect.innerText().catch(() => '');
    if (text.includes(basename)) return true;
    for (const candidate of directoryCandidates) {
      if (text.includes(candidate)) return true;
    }
    return false;
  }, { timeout: 30000 }).toBe(true);
};

export const ensureHostSelected = async (page: Page) => {
  await ensureE2EStorageSeeded(page);

  // Absolute verification that we're using the per-run e2e daemon (never :6767).
  // Also self-heal a rare case where app code rewrites daemon IDs after boot, by
  // realigning create-agent-preferences.serverId to the sole seeded daemon.
  try {
    await assertE2EUsesSeededTestDaemon(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/create-agent-preferences\.serverId/i.test(message)) {
      throw error;
    }

    const fix = await page.evaluate(() => {
      const registryRaw = localStorage.getItem('@paseo:daemon-registry');
      const prefsRaw = localStorage.getItem('@paseo:create-agent-preferences');
      if (!registryRaw || !prefsRaw) return { ok: false, reason: 'missing storage' } as const;
      const registry = JSON.parse(registryRaw) as any[];
      const prefs = JSON.parse(prefsRaw) as any;
      if (!Array.isArray(registry) || registry.length !== 1) return { ok: false, reason: 'registry shape' } as const;
      const serverId = registry[0]?.serverId;
      if (typeof serverId !== 'string' || serverId.length === 0) return { ok: false, reason: 'missing serverId' } as const;
      prefs.serverId = serverId;
      localStorage.setItem('@paseo:create-agent-preferences', JSON.stringify(prefs));
      // Prevent the fixture's init-script from overwriting the corrected prefs on reload.
      const nonce = localStorage.getItem('@paseo:e2e-seed-nonce') ?? '1';
      localStorage.setItem('@paseo:e2e-disable-default-seed-once', nonce);
      return { ok: true } as const;
    });

    if (!fix.ok) {
      throw error;
    }

    await page.reload();
    await assertE2EUsesSeededTestDaemon(page);
  }

  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeVisible();

  if (await input.isEditable()) {
    return;
  }

  const selectHostLabel = page.getByText('Select host', { exact: true });
  if (await selectHostLabel.isVisible()) {
    await selectHostLabel.click();

    // E2E safety: we enforce a single seeded daemon, so the option should be unambiguous.
    const localhostOption = page.getByText('localhost', { exact: true }).first();
    const daemonIdOption = page.getByText(process.env.E2E_SERVER_ID ?? 'srv_e2e_test_daemon', { exact: true }).first();

    if (await localhostOption.isVisible()) {
      await localhostOption.click();
    } else {
      await expect(daemonIdOption).toBeVisible();
      await daemonIdOption.click();
    }
  }

  await expect(input).toBeEditable();
};

export const createAgent = async (page: Page, message: string) => {
  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeEditable();
  await input.fill(message);
  await input.press('Enter');

  // Expo Router navigations can be "same-document" updates, so avoid waiting for a full `load`.
  await page.waitForURL(/\/agent\//, { waitUntil: 'commit' });
  const userBubble = page
    .getByRole('button', { name: 'Copy message' })
    .filter({ hasText: message })
    .first();
  await expect(userBubble).toBeVisible();
};

export interface AgentConfig {
  directory: string;
  provider?: string;
  model?: string;
  mode?: string;
  prompt: string;
}

export const selectProvider = async (page: Page, provider: string) => {
  const providerLabel = page.getByText('PROVIDER', { exact: true }).first();
  await expect(providerLabel).toBeVisible();
  await providerLabel.click();

  const option = page.getByText(provider, { exact: true }).first();
  await expect(option).toBeVisible();
  await option.click();
};

export const selectModel = async (page: Page, model: string) => {
  const modelLabel = page.getByText('MODEL', { exact: true }).first();
  await expect(modelLabel).toBeVisible();
  await modelLabel.click();

  // Wait for the model dropdown to open
  const searchInput = page.getByRole('textbox', { name: /search model/i });
  await expect(searchInput).toBeVisible({ timeout: 10000 });

  // Type to search/filter models
  await searchInput.fill(model);

  const dialog = page.getByRole('dialog');
  const option = dialog
    .getByText(new RegExp(`^${escapeRegex(model)}$`, 'i'))
    .first();
  await expect(option).toBeVisible({ timeout: 30000 });
  await option.click({ force: true });

  // Wait for dropdown to close
  await expect(searchInput).not.toBeVisible({ timeout: 5000 });
};

export const selectMode = async (page: Page, mode: string) => {
  const modeLabel = page.getByText('MODE', { exact: true }).first();
  await expect(modeLabel).toBeVisible();
  await modeLabel.click();

  // Wait for the mode dropdown to open
  const searchInput = page.getByRole('textbox', { name: /search mode/i });
  await expect(searchInput).toBeVisible({ timeout: 10000 });

  // Type to filter modes
  await searchInput.fill(mode);

  const dialog = page.getByRole('dialog');
  const option = dialog
    .getByText(new RegExp(`^${escapeRegex(mode)}$`, 'i'))
    .first();
  await expect(option).toBeVisible();
  await option.click({ force: true });

  // Wait for dropdown to close
  await expect(searchInput).not.toBeVisible({ timeout: 5000 });
};

export const createAgentWithConfig = async (page: Page, config: AgentConfig) => {
  await gotoHome(page);
  await ensureHostSelected(page);
  await setWorkingDirectory(page, config.directory);

  if (config.provider) {
    await selectProvider(page, config.provider);
  }

  if (config.model) {
    await selectModel(page, config.model);
  }

  if (config.mode) {
    await selectMode(page, config.mode);
  }

  await createAgent(page, config.prompt);
};

export const waitForPermissionPrompt = async (page: Page, timeout = 30000) => {
  const promptText = page.getByText('How would you like to proceed?').first();
  await expect(promptText).toBeVisible({ timeout });
};

export const allowPermission = async (page: Page) => {
  const acceptButton = page.getByText('Accept', { exact: true }).first();
  await expect(acceptButton).toBeVisible({ timeout: 5000 });
  await acceptButton.click();
};

export const denyPermission = async (page: Page) => {
  const denyButton = page.getByText('Deny', { exact: true }).first();
  await expect(denyButton).toBeVisible({ timeout: 5000 });
  await denyButton.click();
};

export async function waitForAgentFinishUI(page: Page, timeout = 30000) {
  // Wait for the stop button to disappear
  const stopButton = page.getByRole('button', { name: /stop|cancel/i });

  // First, let's debug what's happening - wait a bit to see the state
  await page.waitForTimeout(2000);

  // Check if stop button is visible
  const isVisible = await stopButton.isVisible().catch(() => false);

  if (isVisible) {
    // If stop button is still visible after permission denial,
    // it might be that the agent is waiting for something.
    // Let's check if there's a tool call result or other UI indication

    // Look for any indication that the agent has processed the permission denial
    const toolCallResult = page.getByText(/permission.*denied|denied|blocked/i);

    // Wait for the tool call result to appear
    await expect(toolCallResult).toBeVisible({ timeout: 10000 }).catch(() => {
      // If no specific message, just wait for the button to disappear
    });

    // Now wait for the stop button to disappear
    await expect(stopButton).not.toBeVisible({ timeout });
  }
}

export async function getToolCallCount(page: Page): Promise<number> {
  // Tool calls are rendered as ExpandableBadge components with tool names like Bash, Write, Read, etc.
  // They appear as pressable badges in the agent stream
  const toolCallBadges = page.locator('[data-testid="tool-call-badge"]');
  return toolCallBadges.count();
}
