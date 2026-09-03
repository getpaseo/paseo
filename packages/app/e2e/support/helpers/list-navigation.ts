import { expect, type Locator, type Page } from "@playwright/test";

type ListNavigationDirection = "next" | "previous";

function navigationKey(direction: ListNavigationDirection): string {
  return direction === "next" ? "Control+n" : "Control+p";
}

async function readBackground(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

export async function captureActiveListHighlight(
  activeItem: Locator,
  inactiveItem: Locator,
): Promise<string> {
  const activeBackground = await readBackground(activeItem);
  expect(activeBackground).not.toBe(await readBackground(inactiveItem));
  return activeBackground;
}

export async function activateFirstListHighlight(page: Page, item: Locator): Promise<string> {
  const inactiveBackground = await readBackground(item);
  await page.keyboard.press(navigationKey("next"));
  await expect.poll(() => readBackground(item)).not.toBe(inactiveBackground);
  return readBackground(item);
}

export async function navigateToHighlightedListItem(
  page: Page,
  direction: ListNavigationDirection,
  item: Locator,
  activeBackground: string,
): Promise<void> {
  await page.keyboard.press(navigationKey(direction));
  await expect.poll(() => readBackground(item)).toBe(activeBackground);
}

export async function navigateToFocusedListItem(
  page: Page,
  direction: ListNavigationDirection,
  item: Locator,
): Promise<void> {
  await page.keyboard.press(navigationKey(direction));
  await expect(item).toBeFocused();
}
