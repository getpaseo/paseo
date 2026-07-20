import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "./fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "./helpers/mock-agent";

function visibleComposer(page: Page) {
  return page.locator("textarea[data-composer-input]").filter({ visible: true }).first();
}

test("adds a changed file to an open chat without replacing its composer draft", async ({
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

    await page
      .getByTestId("workspace-new-agent-tab-inline")
      .filter({ visible: true })
      .first()
      .click();
    await expect(visibleComposer(page)).toBeEditable({ timeout: 30_000 });

    await page.getByRole("button", { name: "Open explorer" }).click();
    await page.getByTestId("explorer-tab-changes").click();
    const changedFile = page.getByText("changed file.ts", { exact: true }).first();
    await expect(changedFile).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("diff-file-0-toggle").click({ button: "right" });
    await page.getByTestId("diff-file-0-add-to-chat").click();

    const picker = page.getByTestId("add-file-to-chat-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByText("Target chat", { exact: true })).toBeVisible();
    await expect(picker.getByText("New Agent", { exact: true })).toBeVisible();
    await picker.getByText("Target chat", { exact: true }).click();

    await expect(agentComposer).toHaveValue('Preserve this thought\n"src/changed file.ts"');
    await expect(agentComposer).toBeFocused();
  } finally {
    await workspace.cleanup();
  }
});
