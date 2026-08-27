import { test } from "../support/fixtures";
import {
  createAgentChatFromLauncher,
  createStandaloneTerminalFromLauncher,
  expectTerminalCwd,
} from "../support/helpers/workspace-lifecycle";

test.describe("Workspace lifecycle", () => {
  // The first test after a spec-file switch can intermittently fail because
  // the shared daemon still holds stale sessions from the previous spec.
  // One retry is enough for the daemon to stabilize.
  test.describe.configure({ retries: 1 });

  test("main checkout creates an agent chat and terminal in the project root", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);
    const workspace = await withWorkspace({ prefix: "lifecycle-main-" });
    await workspace.navigateTo();

    await test.step("creates an agent chat", async () => {
      await createAgentChatFromLauncher(page);
    });

    await test.step("creates a terminal in the project root", async () => {
      await createStandaloneTerminalFromLauncher(page);
      await expectTerminalCwd(page, workspace.repoPath);
    });
  });

  test("worktree creates an agent chat and terminal in its directory", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ worktree: true, prefix: "lifecycle-wt-" });
    await workspace.navigateTo();

    await test.step("creates an agent chat", async () => {
      await createAgentChatFromLauncher(page);
    });

    await test.step("creates a terminal in the worktree", async () => {
      await createStandaloneTerminalFromLauncher(page);
      await expectTerminalCwd(page, workspace.repoPath);
    });
  });
});
