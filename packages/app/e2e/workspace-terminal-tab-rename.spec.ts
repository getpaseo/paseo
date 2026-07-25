import { test, expect, type Page } from "./fixtures";
import { clickNewTerminal, gotoWorkspace } from "./helpers/launcher";
import { renameModalInput, renameModalSubmit } from "./helpers/rename";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";

async function fetchTerminalTitle(
  workspace: SeededWorkspace,
  terminalId: string,
): Promise<string | null> {
  const result = await workspace.client.listTerminals(workspace.repoPath, undefined, {
    workspaceId: workspace.workspaceId,
  });
  const terminal = result.terminals.find((entry) => entry.id === terminalId);
  return terminal?.title ?? null;
}

async function waitForCreatedTerminalId(workspace: SeededWorkspace): Promise<string> {
  await expect
    .poll(
      async () => {
        const result = await workspace.client.listTerminals(workspace.repoPath, undefined, {
          workspaceId: workspace.workspaceId,
        });
        return result.terminals.map((entry) => entry.id);
      },
      { timeout: 30_000 },
    )
    .toHaveLength(1);
  const result = await workspace.client.listTerminals(workspace.repoPath, undefined, {
    workspaceId: workspace.workspaceId,
  });
  const terminal = result.terminals[0];
  if (!terminal) {
    throw new Error("Expected one created terminal");
  }
  return terminal.id;
}

async function cleanupTerminal(
  workspace: SeededWorkspace,
  terminalId: string | null,
): Promise<void> {
  if (terminalId) {
    await workspace.client.killTerminal(terminalId).catch(() => undefined);
  }
  await workspace.cleanup();
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("Workspace terminal tab rename", () => {
  test("right-click copy terminal id writes the terminal id to the clipboard", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-terminal-copy-id-" });
    let terminalId: string | null = null;

    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewTerminal(page);
      terminalId = await waitForCreatedTerminalId(workspace);

      const tab = page.getByTestId(`workspace-tab-terminal_${terminalId}`).first();
      await expect(tab).toBeVisible({ timeout: 15_000 });

      await tab.click({ button: "right" });
      const copyTerminalId = page.getByTestId(
        `workspace-tab-context-terminal_${terminalId}-copy-terminal-id`,
      );
      await expect(copyTerminalId).toBeVisible({ timeout: 10_000 });
      await copyTerminalId.click();

      await expect.poll(() => readClipboard(page)).toBe(terminalId);
    } finally {
      await cleanupTerminal(workspace, terminalId);
    }
  });

  test("right-click rename persists the terminal title and updates the tab label", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-terminal-rename-" });
    let terminalId: string | null = null;

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewTerminal(page);
      terminalId = await waitForCreatedTerminalId(workspace);

      const tab = page.getByTestId(`workspace-tab-terminal_${terminalId}`).first();
      await expect(tab).toBeVisible({ timeout: 15_000 });

      await tab.click({ button: "right" });
      await expect(page.getByTestId(`workspace-tab-context-terminal_${terminalId}`)).toBeVisible({
        timeout: 10_000,
      });
      const renameItem = page.getByTestId(`workspace-tab-context-terminal_${terminalId}-rename`);
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();

      const modalPrefix = `workspace-tab-rename-modal-terminal-${terminalId}`;
      const input = renameModalInput(page, modalPrefix);
      await expect(input).toBeVisible({ timeout: 10_000 });

      await input.fill("My Renamed Terminal");
      await renameModalSubmit(page, modalPrefix).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(tab).toContainText("My Renamed Terminal", { timeout: 15_000 });
      await expect
        .poll(() => fetchTerminalTitle(workspace, terminalId!))
        .toBe("My Renamed Terminal");
    } finally {
      await cleanupTerminal(workspace, terminalId);
    }
  });
});
