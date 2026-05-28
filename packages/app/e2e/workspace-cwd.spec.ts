import { expect, type Page, test } from "./fixtures";
import { clickNewChat, clickNewTerminal } from "./helpers/launcher";
import {
  expectTerminalSurfaceVisible,
  focusTerminalSurface,
  typeInTerminal,
  setupDeterministicPrompt,
  waitForTerminalContent,
} from "./helpers/terminal-perf";

async function installCreateAgentRequestRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const requests: unknown[] = [];
    (
      window as typeof window & {
        __paseoE2eCreateAgentRequests?: unknown[];
      }
    ).__paseoE2eCreateAgentRequests = requests;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data) as {
            type?: unknown;
            message?: { type?: unknown };
          };
          if (parsed.type === "session" && parsed.message?.type === "create_agent_request") {
            requests.push(parsed.message);
          }
        } catch {
          // Ignore non-JSON frames.
        }
      }
      return originalSend.call(this, data);
    };
  });
}

async function getRecordedCreateAgentCwd(page: Page, message: string): Promise<string | null> {
  return page.evaluate((expectedMessage) => {
    const requests =
      (
        window as typeof window & {
          __paseoE2eCreateAgentRequests?: Array<{
            initialPrompt?: string;
            config?: { cwd?: string };
          }>;
        }
      ).__paseoE2eCreateAgentRequests ?? [];

    for (const request of requests) {
      if (request.initialPrompt === expectedMessage) {
        return request.config?.cwd ?? null;
      }
    }
    return null;
  }, message);
}

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

  test("draft tab creates an agent in the workspace cwd", async ({ page, withWorkspace }) => {
    test.setTimeout(60_000);

    await installCreateAgentRequestRecorder(page);
    const workspace = await withWorkspace({ prefix: "workspace-cwd-draft-agent-" });
    await workspace.navigateTo();

    await clickNewChat(page);
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    const message = `cwd draft create ${Date.now()}`;
    await expect(composer).toBeEditable({ timeout: 15_000 });
    await composer.fill(message);
    await composer.press("Enter");
    await expect(page.getByText(message, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    await expect(page.locator('[data-testid^="workspace-tab-agent_"]').first()).toBeVisible({
      timeout: 30_000,
    });

    await expect
      .poll(async () => getRecordedCreateAgentCwd(page, message), { timeout: 30_000 })
      .toBe(workspace.repoPath);
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
