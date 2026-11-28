import { test, expect, type Page } from "../support/fixtures";
import { clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

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

function terminalTab(page: Page, terminalId: string) {
  return page.getByTestId(`workspace-tab-terminal_${terminalId}`).first();
}

async function copyTerminalId(page: Page, terminalId: string): Promise<void> {
  const tab = terminalTab(page, terminalId);
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.click({ button: "right" });
  const copy = page.getByRole("menuitem", { name: /^Copy terminal id/ });
  await expect(copy).toBeVisible({ timeout: 10_000 });
  await copy.click();
}

async function renameTerminalTab(page: Page, terminalId: string, title: string): Promise<void> {
  const tab = terminalTab(page, terminalId);
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.click({ button: "right" });
  const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
  await expect(rename).toBeVisible({ timeout: 10_000 });
  await rename.click();

  const modalPrefix = `workspace-tab-rename-modal-terminal-${terminalId}`;
  const input = renameModalInput(page, modalPrefix);
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(title);
  await renameModalSubmit(page, modalPrefix).click();
  await expect(input).toHaveCount(0, { timeout: 15_000 });
}

test("terminal context menu copies its ID and persists a renamed title", async ({
  context,
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "workspace-terminal-rename-" });
  let terminalId: string | null = null;

  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewTerminal(page);
    const createdTerminalId = await waitForCreatedTerminalId(workspace);
    terminalId = createdTerminalId;

    await test.step("copy the terminal ID from its tab", async () => {
      await copyTerminalId(page, createdTerminalId);
      await expect.poll(() => readClipboard(page)).toBe(createdTerminalId);
    });

    await test.step("rename the same terminal and read back its saved title", async () => {
      await renameTerminalTab(page, createdTerminalId, "My Renamed Terminal");
      await expect(terminalTab(page, createdTerminalId)).toContainText("My Renamed Terminal", {
        timeout: 15_000,
      });
      await expect
        .poll(() => fetchTerminalTitle(workspace, createdTerminalId))
        .toBe("My Renamed Terminal");
    });
  } finally {
    await cleanupTerminal(workspace, terminalId);
  }
});
