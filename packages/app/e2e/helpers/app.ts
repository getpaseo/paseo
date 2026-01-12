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

    const hostOption = page.getByText('localhost', { exact: true }).first();
    if (await hostOption.isVisible()) {
      await hostOption.click();
    } else {
      const fallbackOption = page.getByText('Local Host', { exact: true }).first();
      await expect(fallbackOption).toBeVisible();
      await fallbackOption.click();
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
