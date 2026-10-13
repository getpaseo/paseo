import { expect, type Locator, type Page } from "@playwright/test";

/** The compact workspace sheet, named after the tab it hosts. */
export function workspaceSheet(page: Page, label: string): Locator {
  return page.getByRole("dialog", { name: label });
}

/** The sheet rests at its snap point, docked to the bottom edge. A sheet pushed up past it covers the workspace header. */
export async function expectWorkspaceSheetAtSnap(page: Page, label: string): Promise<void> {
  const viewportHeight = page.viewportSize()?.height ?? 0;
  const sheet = workspaceSheet(page, label);
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      return box ? Math.round(box.y + box.height) : null;
    })
    .toBe(viewportHeight);
}

export async function expectOpenTabCount(page: Page, count: number): Promise<void> {
  await expect(
    page.getByRole("button", { name: `Switch tabs (${count} open)` }).filter({ visible: true }),
  ).toBeVisible();
}

export async function closeWorkspaceSheet(page: Page, label: string): Promise<void> {
  const sheet = workspaceSheet(page, label);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
}

export async function openWorkspaceSheetAsTab(page: Page, label: string): Promise<void> {
  const sheet = workspaceSheet(page, label);
  await sheet.getByRole("button", { name: "Open as tab" }).click();
  await expect(sheet).toHaveCount(0);
}

export async function replaceWorkspaceSheetFileText(
  page: Page,
  label: string,
  content: string,
): Promise<void> {
  const editor = workspaceSheet(page, label)
    .getByTestId("file-source-editor")
    .locator(".cm-content");
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await editor.pressSequentially(content);
}

export async function selectTabFromSwitcher(page: Page, label: string): Promise<void> {
  await page
    .getByRole("button", { name: /Switch tabs/ })
    .filter({ visible: true })
    .click();
  const option = page.getByText(label, { exact: true }).filter({ visible: true }).last();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
}

export async function tapWorkspaceSheetBackdrop(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Bottom sheet backdrop" })
    .click({ position: { x: 10, y: 10 } });
}

/** Runs a close that hits the unsaved-changes guard, and declines the discard. */
export async function expectDeclinedDiscardPrompt(
  page: Page,
  close: () => Promise<void>,
): Promise<void> {
  const prompt = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    await dialog.dismiss();
    return message;
  });
  await close();
  expect(await prompt).toContain("discard the draft");
}
