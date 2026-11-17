import { expect, type Locator, type Page } from "@playwright/test";

const CHANGELOG_SOURCE_URL = "https://raw.githubusercontent.com/getpaseo/paseo/main/CHANGELOG.md";

/**
 * Serves a changelog to the app instead of the repository's.
 *
 * The sheet renders whatever the document contains, so a fixture is how a test
 * states which authoring shapes it cares about.
 */
export async function serveChangelog(page: Page, lines: string[]): Promise<void> {
  await page.route(CHANGELOG_SOURCE_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: lines.join("\n") }),
  );
}

export async function openWhatsNew(page: Page): Promise<Locator> {
  await page.getByTestId("sidebar-help").click();
  await expect(page.getByTestId("sidebar-help-menu")).toBeVisible();
  await page.getByTestId("sidebar-help-changelog").click();

  const sheet = page.getByTestId("changelog-sheet");
  await expect(sheet).toBeVisible();
  return sheet;
}

/** A minor version: `9.1` holds `9.1.0` and every patch of it. */
export function minor(sheet: Locator, version: string): Locator {
  return sheet.getByTestId(`changelog-release-group-${version}`);
}

/** One entry of a minor, such as `9.1.1`. */
export function release(sheet: Locator, version: string): Locator {
  return sheet.getByTestId(`changelog-release-${version}`);
}

/** The one control a minor with highlights has for its entries, in either state. */
export function allChangesToggle(entry: Locator): Locator {
  return entry.getByRole("button", { name: /^(Show|Hide) all changes$/ });
}

export async function showAllChanges(entry: Locator): Promise<void> {
  await entry.getByRole("button", { name: "Show all changes" }).click();
  await expect(entry.getByRole("button", { name: "Hide all changes" })).toBeVisible();
}

export async function hideAllChanges(entry: Locator): Promise<void> {
  await entry.getByRole("button", { name: "Hide all changes" }).click();
  await expect(entry.getByRole("button", { name: "Show all changes" })).toBeVisible();
}
