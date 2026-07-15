import { expect, test } from "./fixtures";
import { openFileExplorer, openFileFromExplorer } from "./helpers/file-explorer";
import { gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "large-file-warning-",
    repo: {
      files: [{ path: "large.bin", content: "\0".repeat(1024 * 1024 + 1) }],
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
  const openPromise = openFileFromExplorer(page, "large.bin");
  const dialog = await dialogPromise;

  expect(dialog.message()).toContain("Open large file?");
  expect(dialog.message()).toContain("large.bin is 1.0 MB");
  await dialog.dismiss();
  await openPromise;
  await expect(page.getByTestId("workspace-tab-file_large.bin")).toHaveCount(0);

  page.once("dialog", (reopenDialog) => reopenDialog.accept());
  await openFileFromExplorer(page, "large.bin");
  await expect(page.getByTestId("workspace-tab-file_large.bin")).toBeVisible();
  await expect(page.getByText("Binary preview unavailable", { exact: true })).toBeVisible();
});
