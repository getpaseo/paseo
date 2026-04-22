import { test, expect, type Page } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import { connectTerminalClient, navigateToTerminal } from "./helpers/terminal-perf";

type RenameTerminalFrame = {
  terminalId: string;
  title: string;
  requestId: string;
};

function captureRenameTerminalFrames(page: Page): RenameTerminalFrame[] {
  const captured: RenameTerminalFrame[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const raw = frame.payload;
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      try {
        const outer = JSON.parse(text) as {
          type?: string;
          message?: {
            type?: string;
            terminalId?: unknown;
            title?: unknown;
            requestId?: unknown;
          };
        };
        const inner = outer.message;
        if (outer.type === "session" && inner?.type === "rename_terminal_request") {
          captured.push({
            terminalId: String(inner.terminalId ?? ""),
            title: String(inner.title ?? ""),
            requestId: String(inner.requestId ?? ""),
          });
        }
      } catch {
        // Ignore non-JSON and binary frames.
      }
    });
  });
  return captured;
}

async function openTerminalTabContextMenu(page: Page, terminalId: string): Promise<void> {
  const tab = page.getByTestId(`workspace-tab-terminal_${terminalId}`).first();
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.click({ button: "right" });

  const contextMenu = page.getByTestId(`workspace-tab-context-terminal_${terminalId}`);
  await expect(contextMenu).toBeVisible({ timeout: 10_000 });
}

async function invokeRenameFromTerminalContextMenu(page: Page, terminalId: string): Promise<void> {
  await openTerminalTabContextMenu(page, terminalId);
  const renameItem = page.getByTestId(`workspace-tab-context-terminal_${terminalId}-rename`);
  await expect(renameItem).toBeVisible({ timeout: 10_000 });
  await renameItem.click();
}

function renameModalInput(page: Page, terminalId: string) {
  return page.getByTestId(`workspace-tab-rename-modal-terminal-${terminalId}-input`);
}

function renameModalSubmit(page: Page, terminalId: string) {
  return page.getByTestId(`workspace-tab-rename-modal-terminal-${terminalId}-submit`);
}

test.describe("Workspace terminal tab rename", () => {
  test("right-click rename sends rename_terminal_request and updates the tab label", async ({
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

      const renameFrames = captureRenameTerminalFrames(page);

      await navigateToTerminal(page, { workspaceId, terminalId });

      const tab = page.getByTestId(`workspace-tab-terminal_${terminalId}`).first();
      await expect(tab).toBeVisible({ timeout: 15_000 });

      await invokeRenameFromTerminalContextMenu(page, terminalId);

      const input = renameModalInput(page, terminalId);
      await expect(input).toBeVisible({ timeout: 10_000 });

      await input.fill("My Renamed Terminal");
      await expect(input).toHaveValue("My Renamed Terminal");

      await renameModalSubmit(page, terminalId).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(tab).toContainText("My Renamed Terminal", { timeout: 15_000 });

      expect(renameFrames.length).toBeGreaterThan(0);
      const lastFrame = renameFrames.at(-1);
      expect(lastFrame?.terminalId).toBe(terminalId);
      expect(lastFrame?.title).toBe("My Renamed Terminal");
      expect(lastFrame?.requestId.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
