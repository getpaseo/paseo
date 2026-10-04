import { expect, test, type Page } from "playwright/test";
import { CATEGORIES } from "../src/plugins/categories";

async function openPlugins(page: Page) {
  await page.goto("/plugins");
  await expect(page.getByRole("heading", { level: 1, name: /^Plugins/ })).toBeVisible();
}

test("browses from the directory into a category, a plugin, and its author", async ({
  page,
  context,
}) => {
  // WebKit has no clipboard permission to grant; record what the page writes instead.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          (window as unknown as { __copied?: string }).__copied = text;
          return Promise.resolve();
        },
      },
    });
  });
  await openPlugins(page);

  await page.getByRole("region", { name: "Categories" }).getByRole("link", { name: /Git/ }).click();
  await expect(page).toHaveURL(/\/plugins\/category\/git$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Git/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);

  await page.getByRole("link", { name: /Fresh Worktrees/ }).click();
  await expect(page).toHaveURL(/\/plugins\/omercnet\/fresh-worktrees$/);
  await expect(page.getByRole("heading", { name: "Fresh Worktrees" })).toHaveCount(1);
  await expect(page.getByText("paseo plugin install omercnet/fresh-worktrees")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { level: 2, name: "Link to this section Behavior", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy to clipboard" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied))
    .toBe("paseo plugin install omercnet/fresh-worktrees");
  await expect(page.getByRole("link", { name: "Git", exact: true })).toHaveAttribute(
    "href",
    "/plugins/category/git",
  );

  await page.getByRole("link", { name: "Omer Cohen" }).click();
  await expect(page).toHaveURL(/\/plugins\/omercnet$/);
  await expect(page.getByRole("heading", { level: 1, name: "Omer Cohen" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Agent Monitor/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Defer/ })).toHaveCount(0);
});

test("ranks plugins on browse pages by installs in a window or by newest", async ({ page }) => {
  await page.goto("/plugins/all");
  await expect(page.getByRole("heading", { level: 1, name: /^All plugins/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Most installed" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "This month" }).click();
  await expect(page).toHaveURL(/\/plugins\/all\?window=month$/);
  await expect(page.getByRole("link", { name: "This month" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  await page.getByRole("link", { name: "Newest" }).click();
  await expect(page).toHaveURL(/\/plugins\/all\?sort=new$/);
  await expect(page.getByRole("navigation", { name: "Time window" })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("link", { name: /Base2Tone/ })).toContainText(
    "ago",
  );
});

test("keeps old category links working", async ({ page }) => {
  await page.goto("/plugins?category=git&sort=new");
  await expect(page).toHaveURL(/\/plugins\/category\/git\?sort=new$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Git/ })).toBeVisible();
});

test("explains a plugin that is not listed", async ({ page }) => {
  await page.goto("/plugins/acme/does-not-exist");
  await expect(page.getByRole("heading", { level: 1, name: "Plugin not found" })).toBeVisible();
  await page.getByRole("link", { name: "Browse all plugins" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Plugins/ })).toBeVisible();
});

test.describe("search engine visits without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("reads directory, category, author, and complete plugin HTML with page metadata", async ({
    page,
  }) => {
    await openPlugins(page);
    await expect(page.getByRole("link", { name: /Base2Tone/ }).first()).toBeVisible();
    await expectPageMetadata(page, "Plugins – Extend Paseo with community plugins", "/plugins");

    await page.goto("/plugins/category/git");
    await expect(page.getByRole("link", { name: /Fresh Worktrees/ })).toBeVisible();
    await expectPageMetadata(page, "Git – Paseo plugins", "/plugins/category/git");

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

  test("returns real 404 pages for unknown plugins, authors, and categories", async ({ page }) => {
    const plugin = await page.goto("/plugins/acme/does-not-exist");
    expect(plugin?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Plugin not found" })).toBeVisible();
    await expect(page).toHaveTitle("Plugin not found – Paseo");
    const author = await page.goto("/plugins/does-not-exist");
    expect(author?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Author not found" })).toBeVisible();
    await expect(page).toHaveTitle("Author not found – Paseo");
    const category = await page.goto("/plugins/category/does-not-exist");
    expect(category?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Category not found" })).toBeVisible();
    await expect(page).toHaveTitle("Category not found – Paseo");
  });

  test("redirects old category links permanently", async ({ request }) => {
    const response = await request.get("/plugins?category=git", { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers().location).toMatch(/\/plugins\/category\/git$/);
  });

  test("discovers plugin, category, and author URLs through robots and the sitemap index", async ({
    request,
  }) => {
    const robots = await request.get("/robots.txt");
    expect(await robots.text()).toContain("Sitemap: https://paseo.sh/sitemap-index.xml");
    const index = await request.get("/sitemap-index.xml");
    expect(await index.text()).toContain("https://paseo.sh/sitemap-plugins.xml");
    const plugins = await request.get("/sitemap-plugins.xml");
    expect(plugins.status()).toBe(200);
    expect(plugins.headers()["content-type"]).toContain("application/xml");
    const sitemap = await plugins.text();
    expect(sitemap).toContain("<loc>https://paseo.sh/plugins/all</loc>");
    expect(sitemap).toContain("<loc>https://paseo.sh/plugins/category/git</loc>");
    expect(sitemap).toContain("<loc>https://paseo.sh/plugins/omercnet</loc>");
    expect(sitemap).toContain("<loc>https://paseo.sh/plugins/omercnet/fresh-worktrees</loc>");
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

test("keeps the directory unlinked until the coordinated announcement", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("banner").getByRole("link", { name: "Plugins", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("contentinfo").getByRole("link", { name: "Plugins", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Community plugins" })).toHaveAttribute(
    "href",
    "https://paseo.cafe",
  );
  await expect(page.locator('a[href="/plugins"]')).toHaveCount(0);
  const response = await page.goto("/plugins");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: /^Plugins/ })).toBeVisible();
});

// External deployments own their registry contents; these assertions use the local fixture.
test.describe("registry fixture layout", () => {
  test.skip(Boolean(process.env.WEBSITE_TEST_URL), "Requires the local registry fixture");

  test("lists the nine categories in order with counts, and the newest plugins first", async ({
    page,
  }) => {
    await openPlugins(page);
    const categories = page.getByRole("region", { name: "Categories" });
    await expect(categories.getByRole("link")).toHaveText(
      CATEGORIES.map((category) => new RegExp(`^${category.label}\\s*\\d+$`)),
    );
    await expect(categories.getByRole("link", { name: /Extras/ })).toContainText("0");
    await expect(
      page.getByRole("region", { name: "What’s new" }).getByRole("link", { name: /Added/ }),
    ).toHaveText([/Base2Tone/, /Sayr/, /PromptKit/, /Defer/]);
  });
});
