import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { openChangesPanel, openChangesTreePanel } from "../support/helpers/workspace-tabs";

function visibleComposer(page: Page) {
  return page.locator("textarea[data-composer-input]").filter({ visible: true }).first();
}

for (const width of [1400, 390]) {
  test(`adds a changed file to the focused chat without replacing its composer draft at ${width}px`, async ({
    page,
  }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "add-file-to-chat-",
      title: "Target chat",
    });
    const relativePath = "src/changed file.ts";

    try {
      await mkdir(path.join(workspace.cwd, "src"), { recursive: true });
      await writeFile(path.join(workspace.cwd, relativePath), "export const changed = true;\n");
      await workspace.client.checkoutRefresh(workspace.cwd);

      await page.setViewportSize({ width, height: 900 });
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      const agentComposer = visibleComposer(page);
      await expect(agentComposer).toBeEditable({ timeout: 30_000 });
      await agentComposer.fill("Preserve this thought");

      if (width < 600) await openChangesTreePanel(page);
      else await openChangesPanel(page);
      const changedFile = page.getByTestId("diff-file-0-toggle");
      await expect(changedFile).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("diff-file-0-toggle").click({ button: "right" });
      await page.getByTestId("diff-file-0-add-to-chat").click();

      const attachment = page.getByTestId("composer-workspace-file-attachment-pill");
      if (width < 600)
        await expect(
          page.getByTestId("workspace-explorer-sidebar").filter({ visible: true }),
        ).toHaveCount(0);
      await expect(attachment).toContainText("changed file.ts");
      await expect(attachment).toContainText(relativePath);
      await expect(agentComposer).toHaveValue("Preserve this thought");
      if (width >= 600) await expect(agentComposer).toBeFocused();
      else await expect(agentComposer).toBeEditable();
    } finally {
      await workspace.cleanup();
    }
  });
}
