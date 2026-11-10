import { expect, test, type Locator, type Page } from "./fixtures";

// The page renders the repository's CHANGELOG.md, so releases are found by shape, never by version:
// a release with highlights has the toggle, a release without them does not.
function releases(page: Page): Locator {
  return page.getByRole("region");
}

// The router resets the scroll position when the page hydrates. A click sent before that is aimed
// at where the control was, so wait for the page to be interactive: the language button is enabled
// once it has hydrated.
async function openChangelog(page: Page): Promise<void> {
  await page.goto("/changelog");
  await expect(page.getByRole("button", { name: /^Language/ }).first()).toBeEnabled();
}

function releaseWithHighlights(page: Page): Locator {
  return releases(page)
    .filter({ has: page.getByText("Show all changes", { exact: true }) })
    .first();
}

function releaseWithoutHighlights(page: Page): Locator {
  return releases(page)
    .filter({ hasNot: page.getByText(/^(Show|Hide) all changes$/) })
    .first();
}

function sectionHeadings(release: Locator): Locator {
  return release.getByRole("heading", { level: 4 });
}

async function showAllChanges(release: Locator): Promise<void> {
  await release.getByText("Show all changes", { exact: true }).click();
  await expect(release.getByText("Hide all changes", { exact: true })).toBeVisible();
}

async function hideAllChanges(release: Locator): Promise<void> {
  await release.getByText("Hide all changes", { exact: true }).click();
  await expect(release.getByText("Show all changes", { exact: true })).toBeVisible();
}

test("shows each release's highlights and opens its sections on request", async ({ page }) => {
  await openChangelog(page);
  const highlighted = releaseWithHighlights(page);
  const plain = releaseWithoutHighlights(page);

  await test.step("tucks away the sections of a release with highlights", async () => {
    await expect(highlighted.getByRole("listitem").first()).toBeVisible();
    await expect(sectionHeadings(highlighted)).toHaveCount(0);
  });

  await test.step("opens and closes them again", async () => {
    await showAllChanges(highlighted);
    await expect(sectionHeadings(highlighted).first()).toBeVisible();

    await hideAllChanges(highlighted);
    await expect(sectionHeadings(highlighted)).toHaveCount(0);
  });

  await test.step("shows a release without highlights whole", async () => {
    await expect(sectionHeadings(plain).first()).toBeVisible();
  });
});

test("opens a release from a deep link with its highlights in view", async ({ page }) => {
  await openChangelog(page);
  const anchor = await releaseWithHighlights(page)
    .getByRole("link", { name: /^Link to Paseo / })
    .getAttribute("href");

  await page.goto(`/changelog${anchor}`);

  const linked = page.locator(`[id="${anchor!.slice(1)}"]`);
  await expect(linked).toBeInViewport();
  await expect(releaseWithHighlights(page).getByRole("listitem").first()).toBeVisible();
});
