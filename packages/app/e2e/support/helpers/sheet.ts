import { expect, type Locator, type Page } from "@playwright/test";

/** A sheet tab's body, named after the tab it shows. */
export function sheet(page: Page, label: string): Locator {
  return page.getByRole("dialog", { name: label });
}

/** A sheet tab's header, which carries its title, Close, and the Open as tab glyph. */
export function sheetHeader(page: Page, label: string): Locator {
  return page.getByTestId("sheet-tab-header").filter({ hasText: label });
}

/** Sheet height as a fraction of the viewport; mirrors the sheet tab's 92% snap point. */
const SHEET_SNAP_FRACTION = 0.92;
/** The header starts below the sheet's drag indicator, inside the handle. */
const SHEET_INDICATOR_MAX_HEIGHT = 32;

/**
 * The sheet rests at its snap point, docked to the bottom edge. A sheet pushed up past it
 * covers the workspace header; a sheet sunk below it hides content.
 */
export async function expectSheetAtSnap(page: Page, label: string): Promise<void> {
  const viewportHeight = page.viewportSize()?.height ?? 0;
  const snapTop = Math.round(viewportHeight * (1 - SHEET_SNAP_FRACTION));
  const header = sheetHeader(page, label);
  const body = sheet(page, label);
  await expect
    .poll(async () => {
      const [headerBox, bodyBox] = await Promise.all([header.boundingBox(), body.boundingBox()]);
      if (!headerBox || !bodyBox) return null;
      const top = Math.round(headerBox.y);
      return {
        dockedToBottom: Math.round(bodyBox.y + bodyBox.height) === viewportHeight,
        topAtSnap: top >= snapTop && top <= snapTop + SHEET_INDICATOR_MAX_HEIGHT,
      };
    })
    .toEqual({ dockedToBottom: true, topAtSnap: true });
}

export async function expectOpenTabCount(page: Page, count: number): Promise<void> {
  await expect(
    page.getByRole("button", { name: `Switch tabs (${count} open)` }).filter({ visible: true }),
  ).toBeVisible();
}

export async function closeSheet(page: Page, label: string): Promise<void> {
  await sheetHeader(page, label).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page, label)).toHaveCount(0);
}

export async function openSheetAsTab(page: Page, label: string): Promise<void> {
  await sheetHeader(page, label).getByRole("button", { name: "Open as tab" }).click();
  await expect(sheet(page, label)).toHaveCount(0);
}

export async function replaceSheetFileText(
  page: Page,
  label: string,
  content: string,
): Promise<void> {
  const editor = sheet(page, label).getByTestId("file-source-editor").locator(".cm-content");
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await editor.pressSequentially(content);
}

export async function selectTabFromSwitcher(page: Page, label: string): Promise<void> {
  await page
    .getByRole("button", { name: /Switch tabs/ })
    .filter({ visible: true })
    .click();
  await expect(page.getByText("Workspace tabs", { exact: true })).toBeVisible();
  const option = page.getByText(label, { exact: true }).filter({ visible: true }).last();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
}

/** Taps the top sheet's backdrop; each stacked sheet renders its own, top last. */
export async function tapSheetBackdrop(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Bottom sheet backdrop" })
    .last()
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
