import { expect, type Locator, type Page } from "@playwright/test";
import { openSettings } from "./app";
import { clickSettingsBackToWorkspace, openSettingsSection } from "./settings";

type ContentWidthOption = "Default" | "Wide" | "Full";

function contentWidthOption(page: Page, option: ContentWidthOption): Locator {
  return page
    .getByTestId("content-width-options")
    .getByRole("button", { name: option, exact: true });
}

export async function chooseContentWidth(page: Page, option: ContentWidthOption): Promise<void> {
  await openSettings(page);
  await openSettingsSection(page, "appearance");
  const button = contentWidthOption(page, option);
  await button.click();
  await expect(button).toHaveAttribute("aria-selected", "true");
  await clickSettingsBackToWorkspace(page);
}

/** Checks the rendered content width, allowing for padding inside the column. */
export async function expectContentColumnWidth(
  element: Locator,
  bounds: { min: number; max: number },
): Promise<void> {
  await expect(element).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await element.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(bounds.min);
  await expect
    .poll(async () => (await element.boundingBox())?.width ?? Infinity)
    .toBeLessThanOrEqual(bounds.max);
}

export async function expectColumnClearOfOutline(column: Locator, outline: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const [content, rail] = await Promise.all([column.boundingBox(), outline.boundingBox()]);
      return content && rail ? content.x - (rail.x + rail.width) : -1;
    })
    .toBeGreaterThanOrEqual(8);
}

export async function expectColumnAtLeftGutter(page: Page, column: Locator): Promise<void> {
  const viewport = page.getByTestId("agent-chat-scroll");
  await expect
    .poll(async () => {
      const [content, scroll] = await Promise.all([column.boundingBox(), viewport.boundingBox()]);
      return content && scroll ? content.x - scroll.x : Infinity;
    })
    .toBeLessThanOrEqual(24);
}
