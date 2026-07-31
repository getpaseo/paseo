import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "./fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "./helpers/mock-agent";

function visibleComposer(page: Page) {
  return page.locator("textarea[data-composer-input]").filter({ visible: true }).first();
}

test("adds a changed file to the focused chat without replacing its composer draft", async ({
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

    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    const agentComposer = visibleComposer(page);
    await expect(agentComposer).toBeEditable({ timeout: 30_000 });
    await agentComposer.fill("Preserve this thought");

    await page.getByRole("button", { name: "Open explorer" }).click();
    await page.getByTestId("explorer-tab-changes").click();
    const changedFile = page.getByText("changed file.ts", { exact: true }).first();
    await expect(changedFile).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("diff-file-0-toggle").click({ button: "right" });
    await page.getByTestId("diff-file-0-add-to-chat").click();

    const attachment = page.getByTestId("composer-workspace-file-attachment-pill");
    await expect(attachment).toContainText("changed file.ts");
    await expect(attachment).toContainText(relativePath);
    await expect(agentComposer).toHaveValue("Preserve this thought");
    await expect(agentComposer).toBeFocused();
  } finally {
    await workspace.cleanup();
  }
});
