import { expect, type Page } from "@playwright/test";

export async function waitForPermissionPrompt(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId("permission-request-question").first()).toBeVisible({ timeout });
}

export async function allowPermission(page: Page): Promise<void> {
  const acceptButton = page.getByTestId("permission-request-accept").first();
  await expect(acceptButton).toBeVisible({ timeout: 5_000 });
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
