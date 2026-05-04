import { test } from "./fixtures";
import {
  createAgentChatFromLauncher,
  createStandaloneTerminalFromLauncher,
  expectTerminalCwd,
} from "./helpers/workspace-lifecycle";

test.describe("Workspace lifecycle", () => {
  // The first test after a spec-file switch can intermittently fail because
  // the shared daemon still holds stale sessions from the previous spec.
  // One retry is enough for the daemon to stabilize.
  test.describe.configure({ retries: 1 });

  test.describe("Main checkout", () => {
    test("creates an agent chat via New Chat", async ({ page, withWorkspace }) => {
      test.setTimeout(60_000);
      const workspace = await withWorkspace({ prefix: "lifecycle-main-chat-" });
      await workspace.navigateTo();
      await createAgentChatFromLauncher(page);
    });

    test("creates a terminal with correct CWD", async ({ page, withWorkspace }) => {
      test.setTimeout(60_000);
      const workspace = await withWorkspace({ prefix: "lifecycle-main-shell-" });
      await workspace.navigateTo();
      await createStandaloneTerminalFromLauncher(page);
      await expectTerminalCwd(page, workspace.repoPath);
    });
  });

  test.describe("Worktree workspace", () => {
    test("creates an agent chat via New Chat", async ({ page, withWorkspace }) => {
      test.setTimeout(90_000);
      const workspace = await withWorkspace({ worktree: true, prefix: "lifecycle-wt-chat-" });
      await workspace.navigateTo();
      await createAgentChatFromLauncher(page);
    });

    test("creates a terminal with correct CWD", async ({ page, withWorkspace }) => {
      test.setTimeout(90_000);
      const workspace = await withWorkspace({ worktree: true, prefix: "lifecycle-wt-shell-" });
      await workspace.navigateTo();
      await createStandaloneTerminalFromLauncher(page);
      await expectTerminalCwd(page, workspace.repoPath);
    });
  });
});
