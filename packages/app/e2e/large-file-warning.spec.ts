import { expect, test } from "./fixtures";
import { openSettings } from "./helpers/app";
import { openFileExplorer, openFileFromExplorer } from "./helpers/file-explorer";
import { gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { clickSettingsBackToWorkspace } from "./helpers/settings";

let workspace: SeededWorkspace;
const largeTextLines = Array.from(
  { length: 5121 },
  (_, index) => `line ${index.toString().padStart(4, "0")} ${"x".repeat(1013)}\n`,
);
const largeTextFileContent = largeTextLines.join("");

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "large-file-warning-",
    repo: {
      files: [{ path: "large.txt", content: largeTextFileContent }],
    },
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test("cancels or opens a large file from the inline warning", async ({ page }) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  await openFileFromExplorer(page, "large.txt");
  await expect(page.getByTestId("workspace-tab-file_large.txt")).toBeVisible();
  const warning = page.getByTestId("large-file-warning");
  await expect(warning).toContainText("Open large file?");
  await expect(warning).toContainText("large.txt is 5.0 MB");

  await page.getByTestId("large-file-warning-cancel").click();
  await expect(page.getByTestId("workspace-tab-file_large.txt")).toHaveCount(0);

  await openFileFromExplorer(page, "large.txt");
  await expect(page.getByTestId("large-file-warning")).toBeVisible();
  await page.getByTestId("large-file-warning-open").click();
  await expect(page.getByTestId("workspace-tab-file_large.txt")).toBeVisible();
  await expect(
    page
      .getByTestId("workspace-file-pane")
      .getByText(/line 0000/)
      .first(),
  ).toBeVisible();
});

test("uses the configured large-file warning threshold", async ({ page }) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await openSettings(page);

  const thresholdInput = page.getByTestId("large-file-warning-threshold-input");
  await expect(thresholdInput).toHaveValue("5");
  await thresholdInput.fill("6");
  await thresholdInput.press("Enter");
  await expect(thresholdInput).toHaveValue("6");

  await clickSettingsBackToWorkspace(page);
  await openFileExplorer(page);
  await openFileFromExplorer(page, "large.txt");

  await expect(page.getByTestId("large-file-warning")).toHaveCount(0);
  await expect(
    page
      .getByTestId("workspace-file-pane")
      .getByText(/line 0000/)
      .first(),
  ).toBeVisible();
});
