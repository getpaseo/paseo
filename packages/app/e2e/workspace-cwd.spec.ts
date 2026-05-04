import { expect, test } from "./fixtures";
import { clickNewTerminal } from "./helpers/launcher";
import { setupDeterministicPrompt, waitForTerminalContent } from "./helpers/terminal-perf";

test.describe("Workspace cwd correctness", () => {
  test("main checkout workspace opens terminals in the project root", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(60_000);

    const workspace = await withWorkspace({ prefix: "workspace-cwd-main-" });
    await workspace.navigateTo();
    await clickNewTerminal(page);

    const terminal = page.locator('[data-testid="terminal-surface"]');
    await expect(terminal.first()).toBeVisible({ timeout: 20_000 });
    await terminal.first().click();

    await setupDeterministicPrompt(page, `PWD_READY_${Date.now()}`);
    await terminal.first().pressSequentially("pwd\n", { delay: 0 });

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

    const terminal = page.locator('[data-testid="terminal-surface"]');
    await expect(terminal.first()).toBeVisible({ timeout: 20_000 });
    await terminal.first().click();

    await setupDeterministicPrompt(page, `PWD_READY_${Date.now()}`);
    await terminal.first().pressSequentially("pwd\n", { delay: 0 });
    await waitForTerminalContent(page, (text) => text.includes(workspace.repoPath), 10_000);
  });
});
