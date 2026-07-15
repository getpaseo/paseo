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

test("cancels or confirms opening a large file", async ({ page }) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const dialogPromise = page.waitForEvent("dialog");
  const openPromise = openFileFromExplorer(page, "large.txt");
  const dialog = await dialogPromise;

  expect(dialog.message()).toContain("Open large file?");
  expect(dialog.message()).toContain("large.txt is 1.0 MB");
  await dialog.dismiss();
  await openPromise;
  await expect(page.getByTestId("workspace-tab-file_large.txt")).toHaveCount(0);

  page.once("dialog", (reopenDialog) => reopenDialog.accept());
  await openFileFromExplorer(page, "large.txt");
  await expect(page.getByTestId("workspace-tab-file_large.txt")).toBeVisible();
  await expect(
    page
      .getByTestId("workspace-file-pane")
      .getByText(/line 0000/)
      .first(),
  ).toBeVisible();
});
