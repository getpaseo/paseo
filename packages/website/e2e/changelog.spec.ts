import { expect, test, waitForHydration, type Locator, type Page } from "./fixtures";

// The page renders the repository's CHANGELOG.md, so minors are found by shape, never by version:
// a minor with highlights has the toggle, a minor without them does not. Each minor is an article,
// and each entry of it, the x.y.0 and every patch, is a region inside it.
function minors(page: Page): Locator {
  return page.getByRole("article");
}

async function openChangelog(page: Page): Promise<void> {
  await page.goto("/changelog");
  await waitForHydration(page);
}

function minorWithHighlights(page: Page): Locator {
  return minors(page)
    .filter({ has: page.getByText("Show all changes", { exact: true }) })
    .first();
}

function minorWithoutHighlights(page: Page): Locator {
  return minors(page)
    .filter({ hasNot: page.getByText(/^(Show|Hide) all changes$/) })
    .first();
}

function entries(minor: Locator): Locator {
  return minor.getByRole("region");
}

function sectionHeadings(minor: Locator): Locator {
  return minor.getByRole("heading", { level: 4 });
}

async function showAllChanges(minor: Locator): Promise<void> {
  await minor.getByText("Show all changes", { exact: true }).click();
  await expect(minor.getByText("Hide all changes", { exact: true })).toBeVisible();
}

async function hideAllChanges(minor: Locator): Promise<void> {
  await minor.getByText("Hide all changes", { exact: true }).click();
  await expect(minor.getByText("Show all changes", { exact: true })).toBeVisible();
}

test("shows each minor's highlights and opens its entries on request", async ({ page }) => {
  await openChangelog(page);
  const highlighted = minorWithHighlights(page);
  const plain = minorWithoutHighlights(page);

  await test.step("tucks away every entry of a minor with highlights", async () => {
    await expect(highlighted.getByRole("listitem").first()).toBeVisible();
    await expect(entries(highlighted)).toHaveCount(0);
    await expect(sectionHeadings(highlighted)).toHaveCount(0);
  });

  await test.step("opens and closes them again, under the highlights", async () => {
    const highlight = highlighted.getByRole("listitem").first();
    await showAllChanges(highlighted);
    await expect(entries(highlighted).first()).toBeVisible();
    await expect(sectionHeadings(highlighted).first()).toBeVisible();
    const highlightBox = await highlight.boundingBox();
    const entryBox = await entries(highlighted).first().boundingBox();
    expect(entryBox!.y).toBeGreaterThan(highlightBox!.y);

    await hideAllChanges(highlighted);
    await expect(entries(highlighted)).toHaveCount(0);
  });

  await test.step("shows the entries of a minor without highlights whole", async () => {
    await expect(sectionHeadings(plain).first()).toBeVisible();
  });
});

test("opens a minor from a deep link with its highlights in view", async ({ page }) => {
  await openChangelog(page);
  const anchor = await minorWithHighlights(page)
    .getByRole("link", { name: /^Link to Paseo / })
    .first()
    .getAttribute("href");

  await page.goto(`/changelog${anchor}`);

  const linked = page.locator(`[id="${anchor!.slice(1)}"]`);
  await expect(linked).toBeInViewport();
  await expect(minorWithHighlights(page).getByRole("listitem").first()).toBeVisible();
});
