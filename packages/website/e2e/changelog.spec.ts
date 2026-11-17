import { expect, test, waitForHydration, type Locator, type Page } from "./fixtures";

// The page renders the repository's CHANGELOG.md, so minors are found by shape, never by version.
// Each minor is an article. A minor with highlights lists its versions as closed rows; a minor
// without them shows its versions open. Each version is a region named by its version.
function minors(page: Page): Locator {
  return page.getByRole("article");
}

async function openChangelog(page: Page): Promise<void> {
  await page.goto("/changelog");
  await waitForHydration(page);
}

function minorWithHighlights(page: Page): Locator {
  return minors(page)
    .filter({ has: page.locator("details") })
    .first();
}

function minorWithoutHighlights(page: Page): Locator {
  return minors(page)
    .filter({ hasNot: page.locator("details") })
    .first();
}

function versions(minor: Locator): Locator {
  return minor.getByRole("region");
}

function sectionHeadings(scope: Locator): Locator {
  return scope.getByRole("heading", { level: 4 });
}

async function toggleVersion(version: Locator): Promise<void> {
  await version.getByRole("heading", { level: 3 }).click();
}

test("shows each minor's highlights over closed version rows", async ({ page }) => {
  await openChangelog(page);
  const highlighted = minorWithHighlights(page);
  const newest = versions(highlighted).first();

  await test.step("shows the highlights and every version closed", async () => {
    await expect(highlighted.getByRole("listitem").first()).toBeVisible();
    await expect(newest.getByRole("heading", { level: 3 })).toBeVisible();
    await expect(sectionHeadings(highlighted)).toHaveCount(0);
  });

  await test.step("opens one version to its changes and closes it again", async () => {
    await toggleVersion(newest);
    await expect(sectionHeadings(newest).first()).toBeVisible();
    await expect(highlighted.getByRole("listitem").first()).toBeVisible();

    await toggleVersion(newest);
    await expect(sectionHeadings(highlighted)).toHaveCount(0);
  });

  await test.step("shows the versions of a minor without highlights open", async () => {
    await expect(sectionHeadings(minorWithoutHighlights(page)).first()).toBeVisible();
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

test("opens the version a link points at", async ({ page }) => {
  await openChangelog(page);
  const newest = versions(minorWithHighlights(page)).first();
  const anchor = await newest.getByRole("link", { name: /^Link to Paseo / }).getAttribute("href");

  // A link opened from elsewhere is a fresh page load, not a hash change on this one.
  await page.goto("about:blank");
  await page.goto(`/changelog${anchor}`);
  await waitForHydration(page);

  const linked = versions(minorWithHighlights(page)).first();
  await expect(page.locator(`[id="${anchor!.slice(1)}"]`)).toBeInViewport();
  await expect(sectionHeadings(linked).first()).toBeVisible();
});
