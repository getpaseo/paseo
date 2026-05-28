import { test, expect } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import { connectTerminalClient, navigateToTerminal } from "./helpers/terminal-perf";
import { captureWsSessionFrames, renameModalInput, renameModalSubmit } from "./helpers/rename";

test.describe("Workspace terminal tab rename", () => {
  test("right-click rename sends terminal.rename.request and updates the tab label", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    const client = await connectTerminalClient();
    const repo = await createTempGitRepo("workspace-terminal-rename-");

    try {
      const seeded = await client.openProject(repo.path);
      if (!seeded.workspace) {
        throw new Error(seeded.error ?? "Failed to seed workspace");
      }
      const workspaceId = seeded.workspace.id;

      const created = await client.createTerminal(repo.path);
      if (!created.terminal) {
        throw new Error(created.error ?? "Failed to create terminal");
      }
      const terminalId = created.terminal.id;

      const renameFrames = captureWsSessionFrames(page, "terminal.rename.request", (inner) => ({
        terminalId: String(inner.terminalId ?? ""),
        title: String(inner.title ?? ""),
        requestId: String(inner.requestId ?? ""),
      }));

      await navigateToTerminal(page, { workspaceId, terminalId });

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

      expect(renameFrames.length).toBeGreaterThan(0);
      const lastFrame = renameFrames.at(-1)!;
      expect(lastFrame.terminalId).toBe(terminalId);
      expect(lastFrame.title).toBe("My Renamed Terminal");
      expect(lastFrame.requestId.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
