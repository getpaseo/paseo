import securityPlugin from "./overview.fixture.json" with { type: "json" };
import { expect, test, type Page, type Locator } from "playwright/test";
import registry from "./registry.fixture.json" with { type: "json" };
import { CATEGORIES } from "../src/plugins/categories";

async function openPlugins(page: Page) {
  await page.goto("/plugins");
  await expect(page.getByRole("heading", { level: 1, name: /^Plugins/ })).toBeVisible();
}

function pluginCards(page: Page, section: string): Locator {
  return page
    .getByRole("region", { name: section })
    .getByRole("link")
    .filter({ hasNotText: /^See all$/ });
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
  await expect(page.getByText("paseo plugin add omercnet/fresh-worktrees")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { level: 2, name: "Behavior", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy to clipboard" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied))
    .toBe("paseo plugin add omercnet/fresh-worktrees");
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

test("filters by search and clears to all plugins", async ({ page }) => {
  await page.goto("/");
  await openPlugins(page);

  await submitSearch(page, "graphite");
  await expect(page).toHaveURL(/\/plugins\/all\?q=graphite$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /^Results for “graphite”/ }),
  ).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: /Graphite/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);

  await searchPlugins(page, "zzzz-nothing");
  await expect(page.getByText("No plugins match.")).toBeVisible();
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/plugins\/all$/);
  await expect(page.getByRole("heading", { level: 1, name: /^All plugins/ })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search plugins" })).toHaveValue("");
});

test("keeps the directory's ranking window when searching", async ({ page }) => {
  await page.goto("/plugins?window=month");
  await submitSearch(page, "graphite");
  await expect(page).toHaveURL(/\/plugins\/all\?q=graphite&window=month$/);
  await expect(page.getByRole("link", { name: "This month" })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("searches for a term typed before the page finished loading", async ({ page }) => {
  const loadScripts = await holdScripts(page);
  await page.goto("/plugins?window=month", { waitUntil: "domcontentloaded" });
  await searchPlugins(page, "graphite");
  await loadScripts();
  await expect(page.getByRole("button", { name: "Clear search" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/plugins\/all\?q=graphite&window=month$/);
});

test("filters browse results for a term typed before the page finished loading", async ({
  page,
}) => {
  await page.goto("/");
  const loadScripts = await holdScripts(page);
  await page.goto("/plugins/all", { waitUntil: "domcontentloaded" });
  const entries = await historyLength(page);
  await searchPlugins(page, "gra");
  await loadScripts();
  await expect(page).toHaveURL(/\/plugins\/all\?q=gra$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Results for “gra”/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);
  expect(await historyLength(page)).toBe(entries + 1);

  await page.goBack();
  await expect(page).toHaveURL(/\/plugins\/all$/);
  await expect(page.getByRole("heading", { level: 1, name: /^All plugins/ })).toBeVisible();
});

test("clears the search with the clear button", async ({ page }) => {
  await page.goto("/plugins/all");
  const searchbox = page.getByRole("searchbox", { name: "Search plugins" });
  const clear = page.getByRole("button", { name: "Clear search" });
  await expect(clear).toHaveCount(0);

  await searchPlugins(page, "graphite");
  await expect(page).toHaveURL(/\/plugins\/all\?q=graphite$/);
  await clear.click();
  await expect(page).toHaveURL(/\/plugins\/all$/);
  await expect(searchbox).toHaveValue("");
  await expect(searchbox).toBeFocused();
  await expect(clear).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: /^All plugins/ })).toBeVisible();
});

test("searches from the directory on submit, and Back returns to the directory", async ({
  page,
}) => {
  await page.goto("/");
  await openPlugins(page);
  const entries = await historyLength(page);

  await typeSearch(page, "gra");
  await expect(page).toHaveURL(/\/plugins$/);
  expect(await historyLength(page)).toBe(entries);

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/plugins\/all\?q=gra$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Results for “gra”/ })).toBeVisible();
  expect(await historyLength(page)).toBe(entries + 1);

  await page.goBack();
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Plugins/ })).toBeVisible();
});

test("filters browse results as you type in one history entry", async ({ page }) => {
  await page.goto("/");
  await page.goto("/plugins/all");
  const entries = await historyLength(page);

  await typeSearch(page, "gra");
  await expect(page).toHaveURL(/\/plugins\/all\?q=gra$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Results for “gra”/ })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: /Graphite/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);
  expect(await historyLength(page)).toBe(entries + 1);

  await page.goBack();
  await expect(page).toHaveURL(/\/plugins\/all$/);
  await expect(page.getByRole("heading", { level: 1, name: /^All plugins/ })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search plugins" })).toHaveValue("");

  await page.goForward();
  await expect(page).toHaveURL(/\/plugins\/all\?q=gra$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Results for “gra”/ })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search plugins" })).toHaveValue("gra");

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: /^Results for “gra”/ })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search plugins" })).toHaveValue("gra");
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
    await expect(page.getByText("paseo plugin add omercnet/fresh-worktrees")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Behavior", exact: true }),
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

  test("renders search results and submits the search form", async ({ page }) => {
    await page.goto("/plugins/all?q=graphite");
    await expect(
      page.getByRole("heading", { level: 1, name: /^Results for “graphite”/ }),
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: /Graphite/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);

    await page.goto("/plugins/category/git");
    await searchPlugins(page, "fresh");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/plugins\/category\/git\?q=fresh$/);
    await expect(
      page.getByRole("heading", { level: 1, name: /^Results for “fresh” in Git/ }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Fresh Worktrees/ })).toBeVisible();
    await page.getByRole("link", { name: "Clear", exact: true }).click();
    await expect(page).toHaveURL(/\/plugins\/category\/git$/);
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
    const search = await request.get("/plugins?q=graphite", { maxRedirects: 0 });
    expect(search.status()).toBe(301);
    expect(search.headers().location).toMatch(/\/plugins\/all\?q=graphite$/);
    const windowed = await request.get("/plugins?q=graphite&window=month", { maxRedirects: 0 });
    expect(windowed.headers().location).toMatch(/\/plugins\/all\?q=graphite&window=month$/);
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

/** Holds the page's scripts so typing lands before hydration; the returned function loads them. */
async function holdScripts(page: Page): Promise<() => Promise<void>> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\.js($|\?)/, async (route) => {
    await held;
    await route.continue();
  });
  return async () => {
    release();
    await page.waitForLoadState("load");
  };
}

async function searchPlugins(page: Page, term: string) {
  await page.getByRole("searchbox", { name: "Search plugins" }).fill(term);
}

async function submitSearch(page: Page, term: string) {
  await searchPlugins(page, term);
  await page.keyboard.press("Enter");
}

async function typeSearch(page: Page, term: string) {
  await page.getByRole("searchbox", { name: "Search plugins" }).pressSequentially(term);
}

async function historyLength(page: Page): Promise<number> {
  return page.evaluate(() => window.history.length);
}

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

test("links the directory from the header, footer and plugins section", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.locator("header").getByRole("link", { name: "Plugins", exact: true }),
  ).toHaveAttribute("href", "/plugins");
  await expect(
    page.locator("footer").getByRole("link", { name: "Plugins", exact: true }),
  ).toHaveAttribute("href", "/plugins");
  await expect(page.getByRole("link", { name: "Browse plugins" })).toHaveAttribute(
    "href",
    "/plugins",
  );
  const response = await page.goto("/plugins");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: /^Plugins/ })).toBeVisible();
});

// External deployments own their registry contents; these assertions use the local fixture.
test.describe("registry fixture layout", () => {
  test.skip(Boolean(process.env.WEBSITE_TEST_URL), "Requires the local registry fixture");

  test("uses density-aware card thumbnails and keeps detail screenshots original", async ({
    page,
  }) => {
    const plugin = registry.plugins.find((entry) => entry.id === "alhassanaraouf/base2tone")!;
    const source = plugin.media[0];
    await openPlugins(page);
    await expectThumbnailCard(
      page.getByRole("region", { name: "What’s new" }).getByRole("link", { name: /Base2Tone/ }),
      source,
      plugin.id,
    );
    await page.goto("/plugins/all");
    const card = page.getByRole("main").getByRole("link", { name: /Base2Tone/ });
    await expectThumbnailCard(card, source, plugin.id);
    await card.click();
    await expect(
      page.getByRole("img", { name: "Base2Tone screenshot 1", exact: true }),
    ).toHaveAttribute("src", source);
  });

  test("shows images and videos as gallery tiles in registry order and opens each in the viewer", async ({
    page,
  }) => {
    const plugin = registry.plugins.find((entry) => entry.id === "omercnet/dracula")!;
    const [firstImage, video] = plugin.media;
    await page.goto(`/plugins/${plugin.id}`);
    const tiles = page.getByRole("link", { name: /^Dracula (screenshot|video) \d$/ });
    await expect(tiles).toHaveCount(3);
    const layout = await tiles.evaluateAll(galleryTiles);
    expect(layout.map((tile) => tile.href)).toEqual(plugin.media);
    expect(new Set(layout.map((tile) => tile.size)).size).toBe(1);
    const preview = tiles.nth(1).locator("video");
    await expect(preview).toHaveAttribute("preload", "metadata");
    await expect(preview).not.toHaveAttribute("controls");
    await expect(preview).not.toHaveAttribute("autoplay");
    expect(await preview.evaluate((element: HTMLVideoElement) => element.muted)).toBe(true);

    const viewer = page.getByRole("dialog");
    await tiles.nth(1).click();
    const playing = viewer.getByLabel("Dracula video 2");
    await expect(playing).toHaveAttribute("src", video);
    await expect(playing).toHaveAttribute("controls", "");
    await expect.poll(() => playing.evaluate(isPaused)).toBe(false);
    // The fixture video is 320x240, so it has to scale up to fill the viewer.
    await expect.poll(() => playing.evaluate(viewerFill)).toBeCloseTo(1, 2);
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(page.locator("dialog video")).toHaveCount(0);

    await tiles.first().click();
    await expect(viewer.getByRole("img", { name: "Dracula screenshot 1" })).toHaveAttribute(
      "src",
      firstImage,
    );
    await viewer.getByRole("button", { name: "Close" }).click();
    await expect(viewer).toBeHidden();
    expect(page.context().pages()).toHaveLength(1);

    const newTab = page.context().waitForEvent("page");
    await tiles.first().click({ modifiers: ["ControlOrMeta"] });
    await expect(await newTab).toHaveURL(firstImage);
    await expect(viewer).toBeHidden();
  });

  test("peeks the next gallery tile at the strip's edge, and fills the row with two", async ({
    page,
  }) => {
    // Wide screens show two tiles and part of the third; phones show one and part of the second.
    for (const [width, expected] of [
      [1280, [1, 1, "peeks"]],
      [375, [1, "peeks", 0]],
    ] as const) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto("/plugins/omercnet/dracula");
      const three = page.getByRole("link", { name: /^Dracula (screenshot|video) \d$/ });
      const shares = await three.evaluateAll(visibleShares);
      expect(shares.map((share) => (share > 0.1 && share < 0.5 ? "peeks" : share))).toEqual(
        expected,
      );
    }

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/plugins/gpambrozio/herald");
    const two = page.getByRole("link", { name: /^Herald screenshot \d$/ });
    expect(await two.evaluateAll(visibleShares)).toEqual([1, 1]);
  });

  test("steps through the viewer with arrow keys and buttons, wrapping at the ends", async ({
    page,
  }) => {
    await page.goto("/plugins/omercnet/dracula");
    const tiles = page.getByRole("link", { name: /^Dracula (screenshot|video) \d$/ });
    const viewer = page.getByRole("dialog");
    const shows = (name: string) =>
      expect(
        viewer.getByRole("img", { name, exact: true }).or(viewer.getByLabel(name, { exact: true })),
      ).toBeVisible();

    await tiles.nth(1).click();
    await expect.poll(() => viewer.getByLabel("Dracula video 2").evaluate(isPaused)).toBe(false);
    await page.keyboard.press("ArrowRight");
    await shows("Dracula screenshot 3");
    await expect(page.locator("dialog video")).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await shows("Dracula screenshot 1");
    await viewer.getByRole("img").click();
    await page.keyboard.press("ArrowLeft");
    await shows("Dracula screenshot 3");

    await viewer.getByRole("button", { name: "Previous" }).click();
    await shows("Dracula video 2");
    await viewer.getByRole("button", { name: "Next" }).click();
    await shows("Dracula screenshot 3");
    await viewer.getByRole("button", { name: "Next" }).click();
    await shows("Dracula screenshot 1");
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
  });

  test("keeps a video that fails to load visible in the viewer", async ({ page }) => {
    const plugin = registry.plugins.find((entry) => entry.id === "gpambrozio/launchd-jobs")!;
    await page.route(plugin.media[0], (route) => route.abort());
    await page.goto(`/plugins/${plugin.id}`);
    await page.getByRole("link", { name: "launchd Jobs video 1" }).click();
    const video = page.getByRole("dialog").getByLabel("launchd Jobs video 1");
    await expect(video).toBeVisible();
    await expect(video).toHaveCSS("opacity", "1");
    await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
  });

  test("shows the plugin tile on cards when its media has no image", async ({ page }) => {
    await page.goto("/plugins/all");
    const card = page.getByRole("main").getByRole("link", { name: /launchd Jobs/ });
    await expect(card.locator("img, video")).toHaveCount(0);
    await card.click();
    await expect(
      page.getByRole("link", { name: "launchd Jobs video 1" }).locator("video"),
    ).toHaveAttribute(
      "src",
      registry.plugins.find((entry) => entry.id === "gpambrozio/launchd-jobs")!.media[0],
    );
  });

  test("features listed plugins above What's new in the registry's order", async ({ page }) => {
    await openPlugins(page);
    await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText("Featured");
    const featured = page.getByRole("region", { name: "Featured" });
    await expect(featured).toContainText("A selection of hand picked plugins");
    await expect(pluginCards(page, "Featured")).toHaveText([/Dracula/, /Herald/, /launchd Jobs/]);
  });

  test("lists the nine categories in order with counts, and the newest plugins first", async ({
    page,
  }) => {
    await openPlugins(page);
    const categories = page.getByRole("region", { name: "Categories" });
    await expect(categories.getByRole("link")).toHaveText(
      CATEGORIES.map((category) => new RegExp(`^${category.label}\\s*\\d+$`)),
    );
    await expect(categories.getByRole("link", { name: /Extras/ })).toContainText("0");
    await expect(pluginCards(page, "What’s new")).toHaveText([
      /Base2Tone/,
      /Sayr/,
      /PromptKit/,
      /Defer/,
    ]);
  });
});

function galleryTiles(links: Element[]) {
  return links.map((link) => ({
    href: link.getAttribute("href"),
    size: `${link.clientWidth}x${link.clientHeight}`,
  }));
}

/** How much of each tile's width the gallery strip shows, rounded to hundredths. */
function visibleShares(links: Element[]) {
  const strip = links[0].parentElement!.getBoundingClientRect();
  return links.map((link) => {
    const tile = link.getBoundingClientRect();
    const shown = Math.min(tile.right, strip.right) - Math.max(tile.left, strip.left);
    return Math.round((Math.max(shown, 0) / tile.width) * 100) / 100;
  });
}

/** The share of the viewer's room the media fills along its limiting axis; 1 fills it. */
function viewerFill(media: HTMLElement) {
  const box = media.getBoundingClientRect();
  return Math.max(box.width / (window.innerWidth * 0.9), box.height / (window.innerHeight * 0.85));
}

function isPaused(video: HTMLVideoElement) {
  return video.paused;
}

async function expectThumbnailCard(card: Locator, source: string, id: string) {
  // Card screenshots are decorative and hidden from the accessibility tree.
  const image = card.locator("img").first();
  const path = (width: number) =>
    `/plugins/thumb/${width}/${encodeURIComponent(source)}?plugin=${encodeURIComponent(id)}`;
  await expect(image).toHaveAttribute("src", path(592));
  await expect(image).toHaveAttribute("srcset", `${path(592)} 1x, ${path(1184)} 2x`);
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(image).toHaveAttribute("decoding", "async");
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(
      () =>
        image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
      { timeout: 15_000 },
    )
    .toBe(true);
  const box = await image.evaluate((element) => {
    const rect = element.parentElement!.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(box.width).toBeGreaterThan(0);
  expect(box.width / box.height).toBeCloseTo(1.6, 2);
}

test("keeps author content inert through SSR and hydration", async ({
  page,
  request,
}, testInfo) => {
  await verifyPluginOverviewResponse(request);
  await openUntrustedPlugin(page);
  await expectPluginOverviewSafe(page);
  await page.reload();
  await expectPluginOverviewSafe(page);
  await testInfo.attach("plugin-overview", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

async function verifyPluginOverviewResponse(request: import("playwright/test").APIRequestContext) {
  const response = await request.get("/plugins/security/overview");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).not.toContain("<script>globalThis.__overviewExecuted=1</script>");
  expect(html).toContain("\\x3C/script>");
}

async function openUntrustedPlugin(page: Page) {
  await page.goto("/plugins/security/overview");
  await expect(page.getByRole("heading", { name: "Overview security", exact: true })).toBeVisible();
}

async function expectPluginOverviewSafe(page: Page) {
  expect(
    await page.evaluate(() => (globalThis as { __overviewExecuted?: number }).__overviewExecuted),
  ).toBeUndefined();
  // Security assertions inspect every emitted attribute, including inaccessible injected elements.
  const violations = await page.locator(".docs-prose").evaluate((root) => {
    const bad: string[] = [];
    for (const element of root.querySelectorAll("*")) {
      if (
        ["SCRIPT", "IFRAME", "SVG", "FORM", "INPUT", "META", "BASE", "STYLE"].includes(
          element.tagName,
        )
      )
        bad.push(element.tagName);
      for (const attr of element.attributes) {
        if (/^on|^style$|^srcdoc$/i.test(attr.name)) bad.push(attr.name);
        if (["href", "src"].includes(attr.name) && !attr.value.startsWith("https://"))
          bad.push(attr.value);
      }
      if (
        element.tagName === "A" &&
        (element.getAttribute("rel") !== "noopener noreferrer nofollow" ||
          element.getAttribute("target") !== "_blank")
      )
        bad.push("unsafe anchor");
    }
    return bad;
  });
  expect(violations).toEqual([]);
  await expect(page.getByRole("link", { name: "Source", exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: /screenshot/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(securityPlugin.name);
  await expect(
    page.getByRole("link", { name: securityPlugin.author.name, exact: true }),
  ).toHaveAttribute("href", "/plugins/security");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    securityPlugin.description,
  );
}
