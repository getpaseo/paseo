import { expect, test } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import {
  delayDirectorySuggestionResponses,
  holdDirectorySuggestionResponses,
  expectOneLineTruncatedFileResult,
  expectStableCommandCenterLayout,
  failDirectorySuggestionRequests,
  startCommandCenterLayoutObservation,
} from "../support/helpers/command-center-file-search";
import {
  scrollCommandCenterAwayFromSelection,
  expectCommandCenterScrollToStayAt,
  expectKeyboardNavigationToResume,
} from "../support/helpers/command-center-scroll";
import { expectFileTabOpen } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const FILE_PATH =
  "packages/app/src/command-center/features/workspace-file-search/layout-stability/needle-layout-stability-command-center.tsx";
const FILE_NAME = "needle-layout-stability-command-center.tsx";
const FILE_DIRECTORY =
  "packages/app/src/command-center/features/workspace-file-search/layout-stability";

function paseoSizedFiles(): Array<{ path: string; content: string }> {
  const files = Array.from({ length: 120 }, (_, index) => ({
    path: `packages/app/src/features/feature-${String(index).padStart(3, "0")}/index.ts`,
    content: `export const feature${index} = ${index};\n`,
  }));
  files.push({ path: FILE_PATH, content: "export const layoutNeedle = true;\n" });
  return files;
}

async function seedMatchingWorkspaces(count: number): Promise<SeededWorkspace[]> {
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      seedWorkspace({
        repoPrefix: `command-center-file-search-error-${String(index).padStart(2, "0")}-`,
        title: `Home failure ${String(index).padStart(2, "0")}`,
      }),
    ),
  );
}

test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36",
});

test("workspace file search stays geometrically stable through delayed loading and results", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-file-search-",
    title: "Paseo-shaped file search",
    repo: { files: paseoSizedFiles() },
  });

  try {
    await delayDirectorySuggestionResponses(page, 800);
    await gotoWorkspace(page, seeded.workspaceId);
    await page.keyboard.press("Meta+P");

    const panel = page.getByTestId("command-center-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "Files" })).toBeVisible();
    await startCommandCenterLayoutObservation(page);

    await panel.getByTestId("command-center-input").fill(FILE_NAME);
    const row = panel.getByRole("button", {
      name: `${FILE_NAME} ${FILE_DIRECTORY}`,
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expectOneLineTruncatedFileResult(row, {
      filename: FILE_NAME,
      path: FILE_DIRECTORY,
    });

    await panel.getByTestId("command-center-input").fill("needle-layout");
    await page.waitForTimeout(150);
    expect(await row.isVisible()).toBe(true);
    await expect(panel.getByTestId("command-center-file-search-loading")).toBeVisible();
    await expect(panel.getByText("Searching files...", { exact: true })).toHaveCount(0);
    await expect(panel.getByTestId("command-center-file-search-loading")).toBeHidden();
    await expectStableCommandCenterLayout(page);

    await row.click();
    await expectFileTabOpen(page, FILE_PATH);
  } finally {
    await seeded.cleanup();
  }
});

test("dropping the files scope leaves the search row the same height", async ({ page }) => {
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-file-search-scope-",
    title: "Scope chip height",
  });

  try {
    await gotoWorkspace(page, seeded.workspaceId);
    await page.keyboard.press("Meta+P");

    const panel = page.getByTestId("command-center-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const header = panel.getByTestId("command-center-header");
    const scoped = await header.boundingBox();

    await page.getByTestId("command-center-files-scope").click();
    await expect(page.getByTestId("command-center-files-scope")).toHaveCount(0);
    const unscoped = await header.boundingBox();

    expect(scoped?.height).toBe(unscoped?.height);
  } finally {
    await seeded.cleanup();
  }
});

test("unscoped command search keeps commands visible and reports file-search failures", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedMatchingWorkspaces(9);

  try {
    await failDirectorySuggestionRequests(page);
    await gotoWorkspace(page, seeded[0].workspaceId);
    const panel = await openCommandCenter(page);
    await panel.getByTestId("command-center-input").fill("home");

    await expect(panel.getByRole("button", { name: "Home", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: /Home failure 08/ })).toBeVisible();
    await expect(panel.getByTestId("command-center-file-search-error")).toHaveText(
      "Error: Test file search transport failure.",
    );
    await expect(panel.getByTestId("command-center-file-search-error")).toBeInViewport({
      ratio: 1,
    });
    await expect(panel.getByText("No matches", { exact: true })).toHaveCount(0);
  } finally {
    await Promise.allSettled(seeded.map((workspace) => workspace.cleanup()));
  }
});

test("manual scrolling cancels a pending file-search reveal and query editing restores it", async ({
  page,
}) => {
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-delayed-scroll-",
    title: "Delayed file search scroll",
    repo: { files: paseoSizedFiles() },
  });
  try {
    const responses = await holdDirectorySuggestionResponses(page);
    await gotoWorkspace(page, seeded.workspaceId);
    await page.keyboard.press("Meta+P");
    const panel = page.getByTestId("command-center-panel");
    await expect(panel).toBeVisible();
    await panel.getByTestId("command-center-input").fill("index");
    await expect(panel.getByTestId("command-center-file-search-loading")).toBeHidden();
    await expect(
      panel.getByRole("button", {
        name: "index.ts packages/app/src/features/feature-000",
        exact: true,
      }),
    ).toBeVisible();

    responses.hold();
    await panel.getByTestId("command-center-input").fill("index.");
    await expect(panel.getByTestId("command-center-file-search-loading")).toBeVisible();
    const offset = await scrollCommandCenterAwayFromSelection(page, panel);
    await responses.release();
    await expect(panel.getByTestId("command-center-file-search-loading")).toBeHidden();
    await expectCommandCenterScrollToStayAt(panel, offset);
    await expectKeyboardNavigationToResume(page, panel, offset);

    const nextOffset = await scrollCommandCenterAwayFromSelection(page, panel);
    await panel.getByTestId("command-center-input").fill("index.ts");
    await expect(panel.getByTestId("command-center-file-search-loading")).toBeHidden();
    await expect
      .poll(() => panel.getByTestId("command-center-results").evaluate((el) => el.scrollTop))
      .toBeLessThan(nextOffset);
    await expect(
      panel.getByRole("button", {
        name: "index.ts packages/app/src/features/feature-000",
        exact: true,
      }),
    ).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+P");
    await expect(panel.getByTestId("command-center-input")).toHaveValue("");
    await panel.getByTestId("command-center-input").fill("index");
    await expect(
      panel.getByRole("button", {
        name: "index.ts packages/app/src/features/feature-000",
        exact: true,
      }),
    ).toBeInViewport({ ratio: 1 });
  } finally {
    await seeded.cleanup();
  }
});

test.describe("Compact file search context", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("a file result opens a sheet above the left sidebar", async ({ page }) => {
    const seeded = await seedWorkspace({
      repoPrefix: "compact-search-file-",
      title: "Compact file lookup",
      repo: { files: [{ path: "lookup.ts", content: "export const lookup = true;\n" }] },
    });
    try {
      await page.goto(`/h/${process.env.E2E_SERVER_ID}/workspace/${seeded.workspaceId}`);
      await page.getByRole("button", { name: "Open menu", exact: true }).click();
      const search = await openCommandCenter(page);
      await search.getByTestId("command-center-input").fill("lookup.ts");
      await search.getByRole("button", { name: "lookup.ts", exact: true }).click();
      await expect(page.getByTestId("sheet-tab-body")).toBeVisible();
      await expect(page.getByTestId("sheet-tab-header")).toContainText("lookup.ts");
      await page
        .getByTestId("sheet-tab-header")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(page.getByTestId("sheet-tab-body")).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Close menu", exact: true })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(page.getByTestId("sidebar-search")).toBeVisible();
    } finally {
      await seeded.cleanup();
    }
  });
});
