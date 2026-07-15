import { expect, test } from "./fixtures";
import { openFileExplorer, openFileFromExplorer } from "./helpers/file-explorer";
import { gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";

let workspace: SeededWorkspace;
const largeTextLines = Array.from(
  { length: 1025 },
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
  await expect(warning).toContainText("large.txt is 1.0 MB");

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
