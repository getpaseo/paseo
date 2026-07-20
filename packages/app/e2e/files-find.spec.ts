import { test, expect } from "./fixtures";
import {
  expandFolder,
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "./helpers/file-explorer";
import { gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";

const FIND_QUERY = "findtoken";
const ACTIVE_MATCH_BACKGROUND = "rgb(217, 119, 6)";

const MARKDOWN_CONTENT = [
  "# Guide Heading",
  "",
  "This paragraph mentions FindToken once here.",
  "",
  "## Section Two",
  "",
  "This is **BoldMark** text, and it repeats FindToken again for the second match.",
  "",
].join("\n");

function findFindTokenSpans(): string[] {
  return Array.from(document.querySelectorAll("span"))
    .filter((element) => element.textContent === "FindToken")
    .map((element) => getComputedStyle(element).backgroundColor);
}

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "files-find-e2e-",
    repo: { files: [{ path: "docs/guide.md", content: MARKDOWN_CONTENT }] },
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test.describe("Files find", () => {
  test("keeps the markdown preview rendered while finding, with distinct active/inactive matches", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await expandFolder(page, "docs");
    await openFileFromExplorer(page, "guide.md");
    await expectFileTabOpen(page, "docs/guide.md");

    // Sanity: the file previews as rendered Markdown before find is opened —
    // "**" emphasis markers are parsed away, not shown as literal text.
    await expect(page.getByText("BoldMark")).toBeVisible();
    await expect(page.getByText("**BoldMark**")).toHaveCount(0);

    await page.keyboard.press("Control+f");
    const findBar = page.getByTestId("file-pane-find-bar");
    await expect(findBar).toBeVisible();
    const input = findBar.getByTestId("pane-find-input");
    await input.fill(FIND_QUERY);
    await expect(findBar.getByText("2 matches", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(findFindTokenSpans)).toHaveLength(2);

    // The preview must stay rendered Markdown while find is active — not
    // fall back to a raw source view (the regression this surface fixed:
    // "keep Markdown files rendered while find is active", file-pane.tsx).
    await expect(page.getByText("**BoldMark**")).toHaveCount(0);
    await expect(page.getByText("# Guide Heading")).toHaveCount(0);
    await expect(page.getByText("Guide Heading")).toBeVisible();

    const firstColors = await page.evaluate(findFindTokenSpans);
    expect(new Set(firstColors).size, "active and inactive matches must differ").toBe(2);
    expect(firstColors).toContain(ACTIVE_MATCH_BACKGROUND);

    await findBar.getByTestId("pane-find-next").click();
    await expect.poll(() => page.evaluate(findFindTokenSpans)).not.toEqual(firstColors);
    const secondColors = await page.evaluate(findFindTokenSpans);
    expect(new Set(secondColors).size).toBe(2);
    expect(secondColors).toContain(ACTIVE_MATCH_BACKGROUND);

    // Still rendered Markdown after navigating between matches too.
    await expect(page.getByText("**BoldMark**")).toHaveCount(0);
  });
});
