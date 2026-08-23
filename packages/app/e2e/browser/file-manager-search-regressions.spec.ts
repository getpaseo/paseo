import { chmod } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { ensureExplorerSidebar, openFilesPanel } from "../support/helpers/workspace-tabs";

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  const lines = Array.from({ length: 220 }, (_, index) =>
    index === 159
      ? "export const uniqueSearchNeedle = true;"
      : `export const line${index + 1} = true;`,
  );
  workspace = await seedWorkspace({
    repoPrefix: "file-manager-search-regressions-",
    repo: { files: [{ path: "src/search.ts", content: `${lines.join("\n")}\n` }] },
  });
});

test.afterAll(async () => {
  await chmod(workspace.repoPath, 0o755).catch(() => undefined);
  await workspace?.cleanup();
});

test("search stays available while the initial tree listing is errored and retried", async ({
  page,
}) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await chmod(workspace.repoPath, 0o000);

  const explorer = await ensureExplorerSidebar(page);
  await explorer.getByTestId("explorer-sidebar-tab-files").click();

  const searchToggle = explorer.getByTestId("files-search-toggle");
  await expect(searchToggle).toBeVisible({ timeout: 30_000 });
  await chmod(workspace.repoPath, 0o755);
  await explorer.getByText("Retry", { exact: true }).click();
  await searchToggle.click();
  await expect(explorer.getByTestId("file-search-pane")).toBeVisible();
});

test("opening the same search match again recenters the file", async ({ page }) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFilesPanel(page);
  await page.getByTestId("files-search-toggle").filter({ visible: true }).click();
  await page.getByTestId("files-search-input").filter({ visible: true }).fill("uniqueSearchNeedle");

  const match = page.getByRole("button", { name: "src/search.ts, line 160" });
  await expect(match).toBeVisible({ timeout: 30_000 });
  await match.click();

  const editor = page.getByTestId("file-source-editor").filter({ visible: true });
  const scroller = editor.locator(".cm-scroller");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);

  await page.getByTestId("explorer-sidebar-tab-files").filter({ visible: true }).click();
  await expect(match).toBeVisible({ timeout: 30_000 });
  await match.click();

  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
