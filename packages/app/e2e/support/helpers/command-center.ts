import { expect, type Locator, type Page } from "@playwright/test";
import { expectFileTabOpen } from "./file-explorer";

// Opens the command center / global search palette from the sidebar and returns its panel.
export async function openCommandCenter(page: Page): Promise<Locator> {
  await page.getByTestId("sidebar-search").click();
  const panel = page.getByTestId("command-center-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/** Opens the file search (Files scope) from the keyboard shortcut. */
export async function openFileSearch(page: Page): Promise<Locator> {
  await page.keyboard.press("Meta+P");
  const panel = page.getByTestId("command-center-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("command-center-files-scope")).toBeVisible();
  return panel;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Types a path into the file search, opens the row it offers, and waits for the file tab.
 *
 * `typedPath` is what the user pastes; `expectedPath` is the path the tab should carry — they
 * differ when the typed path reaches the file through parent segments.
 */
export async function openFileByTypedPath(
  page: Page,
  input: { typedPath: string; expectedPath: string; fileName: string },
): Promise<void> {
  const panel = await openFileSearch(page);
  await panel.getByTestId("command-center-input").fill(input.typedPath);

  const row = panel
    .getByRole("button", { name: new RegExp(escapeForRegExp(input.fileName)) })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  await expectFileTabOpen(page, input.expectedPath);
}

export async function closeCommandCenter(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-center-panel")).not.toBeVisible();
}
