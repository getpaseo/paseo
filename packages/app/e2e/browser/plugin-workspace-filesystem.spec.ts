import { test } from "../support/fixtures";
import { withPluginWorkspaceFileSystem } from "../support/helpers/plugin-workspace-filesystem";

test("plugin files use the native Explorer, file tab, and editor", async ({ page }) => {
  await withPluginWorkspaceFileSystem(page, async (workspace) => {
    await workspace.openRemoteFile();
    await workspace.expectOnlineStatus();
    await workspace.expectEditorText("remote initial");

    await workspace.replaceRemoteText("remote external\n");
    await workspace.expectEditorText("remote external");

    await workspace.saveEditorText("saved through native editor\n");
    await workspace.expectRemoteText("saved through native editor\n");
    await workspace.expectOnlineStatusInCompactSidebar();
  });
});
