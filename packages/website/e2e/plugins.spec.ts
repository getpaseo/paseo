import { expect, test, type Page } from "playwright/test";

async function openPlugins(page: Page) {
  // Wait for hydration so typing reaches React rather than the server-rendered input.
  await page.goto("/plugins", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Plugins" })).toBeVisible();
}

test("browses from the directory into a category, a plugin, and its author", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPlugins(page);

  const themes = page.getByRole("region", { name: "Themes" });
  await expect(themes.getByRole("link", { name: /Dracula/ })).toBeVisible();

  await browseCategory(page, "Git & code review");
  await expect(page).toHaveURL(/category=/);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Themes" })).toHaveCount(0);

  await openPlugin(page, /Fresh Worktrees/);
  await expect(page).toHaveURL(/\/plugins\/omercnet\/fresh-worktrees$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Fresh Worktrees", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("paseo plugin install omercnet/fresh-worktrees")).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Link to this section Behavior", exact: true }),
  ).toBeVisible();
  await copyInstallCommand(page);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("paseo plugin install omercnet/fresh-worktrees");

  const breadcrumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumbs).toContainText("Plugins");
  await expect(breadcrumbs).toContainText("Git & code review");
  await expect(breadcrumbs).toContainText("Fresh Worktrees");

  await openAuthor(page, "Omer Cohen");
  await expect(page).toHaveURL(/\/plugins\/omercnet$/);
  await expect(page.getByRole("heading", { level: 1, name: "Omer Cohen" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Agent Monitor/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Defer/ })).toHaveCount(0);
});

test("filters by search and clears to the full directory", async ({ page }) => {
  await openPlugins(page);

  await searchPlugins(page, "graphite");
  await expect(page).toHaveURL(/q=graphite/);
  await expect(page.getByRole("heading", { level: 2, name: /Results for/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Graphite/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);

  await searchPlugins(page, "zzzz-nothing");
  await expect(page.getByText("No plugins match.")).toBeVisible();
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/plugins\/?$/);
  await expect(page.getByRole("region", { name: "Themes" })).toBeVisible();
});

test("explains a plugin that is not listed", async ({ page }) => {
  await page.goto("/plugins/acme/does-not-exist");
  await expect(page.getByRole("heading", { level: 1, name: "Plugin not found" })).toBeVisible();
  await page.getByRole("link", { name: "Browse all plugins" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Plugins" })).toBeVisible();
});

async function copyInstallCommand(page: Page) {
  await page.getByRole("button", { name: "Copy to clipboard" }).first().click();
}

async function browseCategory(page: Page, category: string) {
  await page
    .getByRole("region", { name: category })
    .getByRole("link", { name: /^View all/ })
    .click();
}
async function openPlugin(page: Page, name: RegExp) {
  await page.getByRole("link", { name }).first().click();
}
async function openAuthor(page: Page, name: string) {
  await page.getByRole("link", { name }).first().click();
}
async function searchPlugins(page: Page, query: string) {
  await page.getByRole("searchbox", { name: "Search plugins" }).fill(query);
}
