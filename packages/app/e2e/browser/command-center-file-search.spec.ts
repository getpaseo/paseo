import { expect, test } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import {
  delayDirectorySuggestionResponses,
  expectOneLineTruncatedFileResult,
  expectStableCommandCenterLayout,
  failDirectorySuggestionRequests,
  startCommandCenterLayoutObservation,
} from "../support/helpers/command-center-file-search";
import { expectFileTabOpen } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

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

test("unscoped command search keeps commands visible and reports file-search failures", async ({
  page,
}) => {
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-file-search-error-",
    title: "File search error",
  });

  try {
    await failDirectorySuggestionRequests(page);
    await gotoWorkspace(page, seeded.workspaceId);
    const panel = await openCommandCenter(page);
    await panel.getByTestId("command-center-input").fill("home");

    await expect(panel.getByRole("button", { name: "Home" })).toBeVisible();
    await expect(panel.getByTestId("command-center-file-search-error")).toHaveText(
      "Error: Test file search transport failure.",
    );
    await expect(panel.getByText("No matches", { exact: true })).toHaveCount(0);
  } finally {
    await seeded.cleanup();
  }
});
