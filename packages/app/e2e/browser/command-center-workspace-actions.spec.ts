import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import {
  createTerminalFromCommandCenter,
  expectDefaultWorkspaceActions,
  expectWorkspaceActionsAvailableThroughSearch,
  makeWorkspacePrimaryGitActionCommit,
  openWorkspaceFromCommandCenter,
} from "../support/helpers/command-center-workspace-actions";
import { seedWorkspace } from "../support/helpers/seed-client";

test("workspace actions use the Git policy and dispatch through the active workspace", async ({
  page,
}) => {
  const title = "Command Center Workspace Actions";
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-workspace-actions-",
    title,
  });

  try {
    await makeWorkspacePrimaryGitActionCommit(seeded);
    await gotoAppShell(page);
    await openWorkspaceFromCommandCenter(page, seeded, title);

    const panel = await openCommandCenter(page);
    await expectDefaultWorkspaceActions(panel);
    await expectWorkspaceActionsAvailableThroughSearch(panel);
    await createTerminalFromCommandCenter(page, panel);
  } finally {
    await seeded.cleanup();
  }
});
