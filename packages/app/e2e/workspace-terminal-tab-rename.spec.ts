import { test, expect } from "./fixtures";
import { TerminalE2EHarness, withTerminalInApp } from "./helpers/terminal-dsl";
import { captureWsSessionFrames, renameModalInput, renameModalSubmit } from "./helpers/rename";

test.describe("Workspace terminal tab rename", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "workspace-terminal-rename-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("right-click rename sends terminal.rename.request and updates the tab label", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    const renameFrames = captureWsSessionFrames(page, "terminal.rename.request", (inner) => ({
      terminalId: String(inner.terminalId ?? ""),
      title: String(inner.title ?? ""),
      requestId: String(inner.requestId ?? ""),
    }));

    await withTerminalInApp(page, harness, { name: "rename-target" }, async (terminal) => {
      const tab = page.getByTestId(`workspace-tab-terminal_${terminal.id}`).first();
      await expect(tab).toBeVisible({ timeout: 15_000 });

      await tab.click({ button: "right" });
      await expect(page.getByTestId(`workspace-tab-context-terminal_${terminal.id}`)).toBeVisible({
        timeout: 10_000,
      });
      const renameItem = page.getByTestId(`workspace-tab-context-terminal_${terminal.id}-rename`);
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();

      const modalPrefix = `workspace-tab-rename-modal-terminal-${terminal.id}`;
      const input = renameModalInput(page, modalPrefix);
      await expect(input).toBeVisible({ timeout: 10_000 });

      await input.fill("My Renamed Terminal");
      await renameModalSubmit(page, modalPrefix).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(tab).toContainText("My Renamed Terminal", { timeout: 15_000 });

      expect(renameFrames.length).toBeGreaterThan(0);
      const lastFrame = renameFrames.at(-1)!;
      expect(lastFrame.terminalId).toBe(terminal.id);
      expect(lastFrame.title).toBe("My Renamed Terminal");
      expect(lastFrame.requestId.length).toBeGreaterThan(0);
    });
  });
});
