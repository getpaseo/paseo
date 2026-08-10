import { expect, type Page } from "@playwright/test";

export async function waitForPermissionPrompt(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId("permission-request-question").first()).toBeVisible({ timeout });
}

/**
 * On a plan card this button approves in the mode named on it, which comes from
 * client storage. E2E runs start with empty storage, so it is always the
 * "Accept File Edits" default — asserted rather than assumed, because a change
 * to that default silently changes what every plan-approving spec approves with.
 * The mode picker beside it is what marks a card as a plan card; other
 * permission cards have no mode and no such text.
 */
export async function allowPermission(page: Page): Promise<void> {
  const acceptButton = page.getByTestId("permission-request-accept").first();
  await expect(acceptButton).toBeVisible({ timeout: 5_000 });
  const modePicker = page.getByTestId("permission-request-implement-mode").first();
  if (await modePicker.isVisible()) {
    await expect(acceptButton).toContainText("Accept File Edits");
  }
  await acceptButton.click();
}

export async function denyPermission(page: Page): Promise<void> {
  const denyButton = page.getByTestId("permission-request-deny").first();
  await expect(denyButton).toBeVisible({ timeout: 5_000 });
  await denyButton.click();
}

export async function expectPermissionActions(page: Page, labels: string[]): Promise<void> {
  await waitForPermissionPrompt(page, 120_000);
  const card = page.getByTestId("permission-request-question").first().locator("..");
  for (const label of labels) {
    await expect(card.getByRole("button", { name: label })).toBeVisible();
  }
}

export async function choosePermissionAction(page: Page, label: string): Promise<void> {
  const card = page.getByTestId("permission-request-question").first().locator("..");
  await card.getByRole("button", { name: label }).click();
}
