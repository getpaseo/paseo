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
import { createTempGitRepo } from "./helpers/workspace";
import {
  connectWorkspaceSetupClient,
  openProjectViaDaemon,
  type WorkspaceSetupDaemonClient,
} from "./helpers/workspace-setup";

let tempRepo: { path: string; cleanup: () => Promise<void> };
let workspaceId: string;
let seedClient: WorkspaceSetupDaemonClient;

test.beforeAll(async () => {
  tempRepo = await createTempGitRepo("file-explorer-collapse-", {
    files: [
      { path: "assets/logo.png", content: "image bytes for explorer e2e\n" },
      { path: "docs/guide.md", content: "# Guide\n" },
    ],
  });
  seedClient = await connectWorkspaceSetupClient();
  const workspace = await openProjectViaDaemon(seedClient, tempRepo.path);
  workspaceId = workspace.id;
});

test.afterAll(async () => {
  await seedClient?.close();
  await tempRepo?.cleanup();
});

test.describe("File explorer collapse", () => {
  test("collapses an opened image file parent folder and still expands other folders", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspaceId);
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
