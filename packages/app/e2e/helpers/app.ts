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

  const needsReset = await page.evaluate(({ expectedEndpoint }) => {
    const raw = localStorage.getItem('@paseo:daemon-registry');
    if (!raw) return true;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length !== 1) return true;
      const entry = parsed[0] as any;
      const endpoints = entry?.endpoints;
      if (!Array.isArray(endpoints)) return true;
      if (endpoints.some((e: unknown) => typeof e === 'string' && /:6767\b/.test(e))) return true;
      return !endpoints.some((e: unknown) => e === expectedEndpoint);
    } catch {
      return true;
    }
  }, { expectedEndpoint });

  if (!needsReset) {
    return;
  }

  const nowIso = new Date().toISOString();
  await page.evaluate(
    ({ expectedEndpoint, nowIso }) => {
      localStorage.setItem('@paseo:e2e', '1');
      localStorage.setItem(
        '@paseo:daemon-registry',
        JSON.stringify([
          {
            id: 'e2e-test-daemon',
            label: 'localhost',
            endpoints: [expectedEndpoint],
            relay: null,
            metadata: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ])
      );
      localStorage.setItem(
        '@paseo:create-agent-preferences',
        JSON.stringify({
          serverId: 'e2e-test-daemon',
          provider: 'claude',
          providerPreferences: {
            claude: { model: 'haiku' },
            codex: { model: 'gpt-5.1-codex-mini' },
          },
        })
      );
      localStorage.removeItem('@paseo:settings');
    },
    { expectedEndpoint, nowIso }
  );

  await page.reload();
}

async function assertE2EUsesSeededTestDaemon(page: Page): Promise<void> {
  const port = getE2EDaemonPort();
  const expectedEndpoint = `127.0.0.1:${port}`;

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
  if (typeof daemon?.id !== 'string' || daemon.id.length === 0) {
    throw new Error(`E2E expected seeded daemon to have a string id (got ${String(daemon?.id)}).`);
  }

  const endpoints: unknown = daemon?.endpoints;
  if (!Array.isArray(endpoints) || !endpoints.some((e) => e === expectedEndpoint)) {
    throw new Error(
      `E2E expected seeded daemon endpoints to include ${expectedEndpoint} (got ${JSON.stringify(endpoints)}).`
    );
  }
  if (Array.isArray(endpoints) && endpoints.some((e) => typeof e === 'string' && /:6767\b/.test(e))) {
    throw new Error(`E2E detected a daemon endpoint pointing at :6767 (${JSON.stringify(endpoints)}).`);
  }

  if (!snapshot.prefsRaw) {
    throw new Error('E2E expected @paseo:create-agent-preferences to be set before app load.');
  }
  try {
    const prefs = JSON.parse(snapshot.prefsRaw) as any;
    if (prefs?.serverId !== daemon.id) {
      throw new Error(
        `E2E expected create-agent-preferences.serverId to match seeded daemon id (${daemon.id}) (got ${String(prefs?.serverId)}).`
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
  await expect(page.getByText('New Agent', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeVisible();
};

export const openSettings = async (page: Page) => {
  const settingsLink = page.getByText('Settings', { exact: true }).first();
  await expect(settingsLink).toBeVisible();
  await settingsLink.click();
  await expect(page).toHaveURL(/\/settings$/);
};

export const setWorkingDirectory = async (page: Page, directory: string) => {
  const workingDirectoryLabel = page.getByText('WORKING DIRECTORY', { exact: true }).first();
  await expect(workingDirectoryLabel).toBeVisible();

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
    await workingDirectoryLabel.click({ force: true });
    if (!(await input.isVisible())) {
      await closeBottomSheet();
      await workingDirectoryLabel.click({ force: true });
    }
    await expect(input).toBeVisible();
  }

  await input.fill(directory);
  await input.press('Enter');

  const useOption = page.getByText(`Use "${directory}"`);
  await expect(useOption).toBeVisible();
  await useOption.click({ force: true });
  const normalizedDirectory = directory.startsWith('/var/')
    ? `/private${directory}`
    : directory;
  const workingDirectoryContainer = workingDirectoryLabel.locator('..');
  await expect.poll(async () => {
    const text = await workingDirectoryContainer.innerText();
    return text.includes(directory) || text.includes(normalizedDirectory);
  }).toBe(true);
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
      const daemonId = registry[0]?.id;
      if (typeof daemonId !== 'string' || daemonId.length === 0) return { ok: false, reason: 'missing daemon id' } as const;
      prefs.serverId = daemonId;
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
    const daemonIdOption = page.getByText('e2e-test-daemon', { exact: true }).first();

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

  await page.waitForURL(/\/agent\//);
  await expect(page.getByText(message, { exact: true })).toBeVisible();
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
  const allowButton = page.getByText('Allow', { exact: true }).first();
  await expect(allowButton).toBeVisible({ timeout: 5000 });
  await allowButton.click();
};

export const denyPermission = async (page: Page) => {
  const denyButton = page.getByText('Deny', { exact: true }).first();
  await expect(denyButton).toBeVisible({ timeout: 5000 });
  await denyButton.click();
};

export async function waitForAgentIdle(page: Page, timeout = 30000) {
  const stopButton = page.getByRole('button', { name: /stop|cancel/i });
  await expect(stopButton).not.toBeVisible({ timeout });
}

export async function getToolCallCount(page: Page): Promise<number> {
  // Tool calls are rendered as ExpandableBadge components with tool names like Bash, Write, Read, etc.
  // They appear as pressable badges in the agent stream
  const toolCallBadges = page.locator('[data-testid="tool-call-badge"]');
  return toolCallBadges.count();
}
