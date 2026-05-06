import { test } from "./fixtures";
import { clickNewTerminal } from "./helpers/launcher";
import {
  expectTerminalSurfaceVisible,
  focusTerminalSurface,
  typeInTerminal,
  setupDeterministicPrompt,
  waitForTerminalContent,
} from "./helpers/terminal-perf";

test.describe("Workspace cwd correctness", () => {
  test("main checkout workspace opens terminals in the project root", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);

    const workspace = await withWorkspace({ prefix: "workspace-cwd-main-" });
    await workspace.navigateTo();
    await clickNewTerminal(page);

    await expectTerminalSurfaceVisible(page);
    await focusTerminalSurface(page);
    await setupDeterministicPrompt(page, `PWD_READY_${Date.now()}`);
    await typeInTerminal(page, "pwd\n");
    await waitForTerminalContent(page, (text) => text.includes(workspace.repoPath), 10_000);
  });

  test("worktree workspace opens terminals in the worktree directory", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);

    const workspace = await withWorkspace({ worktree: true, prefix: "workspace-cwd-worktree-" });
    await workspace.navigateTo();
    await clickNewTerminal(page);

    await expectTerminalSurfaceVisible(page);
    await focusTerminalSurface(page);
    await setupDeterministicPrompt(page, `PWD_READY_${Date.now()}`);
    await typeInTerminal(page, "pwd\n");
    await waitForTerminalContent(page, (text) => text.includes(workspace.repoPath), 10_000);
  });
});
