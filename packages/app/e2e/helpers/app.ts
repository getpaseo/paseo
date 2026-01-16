import { expect, type Page } from '@playwright/test';

export const gotoHome = async (page: Page) => {
  await page.goto('/');
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
  await workingDirectoryLabel.click();

  const input = page.getByRole('textbox', { name: '/path/to/project' });
  await expect(input).toBeVisible();
  await input.fill(directory);
  await input.press('Enter');

  const useOption = page.getByText(`Use "${directory}"`);
  await expect(useOption).toBeVisible();
  await useOption.click();
  await expect(page.getByText(directory, { exact: true })).toBeVisible();
};

export const ensureHostSelected = async (page: Page) => {
  const input = page.getByRole('textbox', { name: 'Message agent...' });
  await expect(input).toBeVisible();

  if (await input.isEditable()) {
    return;
  }

  const selectHost = page.getByText('Select host', { exact: true });
  if (await selectHost.isVisible()) {
    await selectHost.click();

    // Wait for the host option to appear and click it
    const hostOption = page.getByText('localhost', { exact: true }).first();
    await expect(hostOption).toBeVisible();
    await hostOption.click();
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

  // Wait for a matching option to appear (partial match via regex)
  const option = page.getByText(new RegExp(model, 'i')).first();
  await expect(option).toBeVisible({ timeout: 30000 });
  await option.click();

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

  // Click the matching option (use last() since the field label also contains the mode text)
  const option = page.getByText(mode, { exact: true }).last();
  await expect(option).toBeVisible();
  await option.click();

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
