import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { expectWorkspaceBranch, switchBranchFromHeader } from "./helpers/branch-switcher";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { readWorktreeBranchInfo } from "./helpers/workspace";
import { switchWorkspaceViaSidebar, waitForSidebarHydration } from "./helpers/workspace-ui";

test.describe("Branch switcher", () => {
  // The first test after a spec-file switch can fail while the shared daemon
  // releases stale sessions from the previous spec; one retry stabilizes it.
  test.describe.configure({ retries: 1 });

  test("switches the workspace branch from the header for an opaque workspace id", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const serverId = getServerId();
    const workspace = await seedWorkspace({
      repoPrefix: "branch-switch-",
      repo: { branches: ["main", "dev"] },
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({ page, serverId, workspaceId: workspace.workspaceId });

      await expectWorkspaceBranch(page, "main");
      await switchBranchFromHeader(page, { from: "main", to: "dev" });
      await expectWorkspaceBranch(page, "dev");

      await expect
        .poll(
          async () =>
            (await readWorktreeBranchInfo({ worktreePath: workspace.repoPath })).currentBranch,
          { timeout: 30_000 },
        )
        .toBe("dev");
    } finally {
      await workspace.cleanup();
    }
  });
});
