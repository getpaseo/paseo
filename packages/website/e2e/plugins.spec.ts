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

test.describe("search engine visits without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("reads directory, author, and complete plugin HTML with page metadata", async ({ page }) => {
    await openPlugins(page);
    await expect(page.getByRole("link", { name: /Fresh Worktrees/ }).first()).toBeVisible();
    await expectPageMetadata(page, "Plugins – Extend Paseo with community plugins", "/plugins");

    await page.goto("/plugins/omercnet");
    await expect(page.getByRole("heading", { level: 1, name: "Omer Cohen" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Fresh Worktrees/ }).first()).toBeVisible();
    await expectPageMetadata(page, "Omer Cohen – Paseo plugins", "/plugins/omercnet");

    const response = await page.goto("/plugins/omercnet/fresh-worktrees");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    expect(response?.headers()["x-robots-tag"]).toBeUndefined();
    await expect(page.getByText("paseo plugin install omercnet/fresh-worktrees")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Link to this section Behavior", exact: true }),
    ).toBeVisible();
    await expectPageMetadata(
      page,
      "Fresh Worktrees – Paseo plugin",
      "/plugins/omercnet/fresh-worktrees",
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      "https://raw.githubusercontent.com/omercnet/paseo-plugins/main/fresh-worktrees/docs/images/fresh-worktrees-behind.png",
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      "Fast-forwards clean local base branches before Paseo creates branch-off worktrees",
    );
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

    await page.goto("/plugins/tomgrin10/graphite");
    await expectPageMetadata(page, "Graphite – Paseo plugin", "/plugins/tomgrin10/graphite");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      "https://paseo.sh/og-image.png",
    );
  });

  test("returns real 404 pages for unknown plugins and authors", async ({ page }) => {
    const plugin = await page.goto("/plugins/acme/does-not-exist");
    expect(plugin?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Plugin not found" })).toBeVisible();
    await expect(page).toHaveTitle("Plugin not found – Paseo");
    const author = await page.goto("/plugins/does-not-exist");
    expect(author?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Author not found" })).toBeVisible();
    await expect(page).toHaveTitle("Author not found – Paseo");
  });

  test("discovers plugin and author URLs through robots and the sitemap index", async ({
    request,
  }) => {
    const robots = await request.get("/robots.txt");
    expect(await robots.text()).toContain("Sitemap: https://paseo.sh/sitemap-index.xml");
    const index = await request.get("/sitemap-index.xml");
    expect(await index.text()).toContain("https://paseo.sh/sitemap-plugins.xml");
    const plugins = await request.get("/sitemap-plugins.xml");
    expect(plugins.status()).toBe(200);
    expect(plugins.headers()["content-type"]).toContain("application/xml");
    expect(await plugins.text()).toContain("<loc>https://paseo.sh/plugins/omercnet</loc>");
    expect(await plugins.text()).toContain(
      "<loc>https://paseo.sh/plugins/omercnet/fresh-worktrees</loc>",
    );
  });
});

async function expectPageMetadata(page: Page, title: string, path: string) {
  await expect(page).toHaveTitle(title);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    `https://paseo.sh${path}`,
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", title);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    "content",
    `https://paseo.sh${path}`,
  );
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );
  const description = await page.locator('meta[name="description"]').getAttribute("content");
  expect(description).toBeTruthy();
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    "content",
    description!,
  );
}
