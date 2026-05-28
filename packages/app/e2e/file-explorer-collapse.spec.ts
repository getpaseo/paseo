import { test } from "./fixtures";
import {
  collapseFolder,
  expandFolder,
  expectExplorerEntryHidden,
  expectExplorerEntryVisible,
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "./helpers/file-explorer";
import { gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "file-explorer-collapse-",
    repo: {
      files: [
        { path: "assets/logo.png", content: "image bytes for explorer e2e\n" },
        { path: "docs/guide.md", content: "# Guide\n" },
      ],
    },
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test.describe("File explorer collapse", () => {
  test("collapses an opened image file parent folder and still expands other folders", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);

    await expandFolder(page, "assets");
    await expectExplorerEntryVisible(page, "logo.png");

    await openFileFromExplorer(page, "logo.png");
    await expectFileTabOpen(page, "assets/logo.png");

    await collapseFolder(page, "assets");
    await expectExplorerEntryHidden(page, "logo.png");

    await expandFolder(page, "docs");
    await expectExplorerEntryVisible(page, "guide.md");
  });
});
