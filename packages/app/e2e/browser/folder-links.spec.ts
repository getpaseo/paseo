import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

async function openReportedFolderLink(page: Page, name: string) {
  const link = page.getByTestId("assistant-message").getByRole("link", { name, exact: true });
  await link.click();
}

async function expectFolderContents(page: Page) {
  await expect(page.getByText("Requested path is not a file", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("file-explorer-tree-scroll")).toBeVisible();
  await expect(
    page.getByTestId("file-explorer-tree-scroll").getByText("guide.md", { exact: true }),
  ).toBeVisible();
}

for (const folder of [
  "./docs/guides",
  "./docs/guides/",
  "./docs/reports.v1",
  "./.github/workflows",
  "docs/guides",
  "docs/guides/",
  "docs/指南",
]) {
  test(`chat folder link opens folder contents: ${folder}`, async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "folder-link-repro-",
      title: "Folder link reproduction",
      initialPrompt: "Show the folder link",
      featureValues: { mockAssistantResponse: `[Open folder](${folder})` },
    });
    try {
      await mkdir(path.join(session.cwd, folder), { recursive: true });
      await writeFile(path.join(session.cwd, folder, "guide.md"), "# Folder link destination\n");
      await session.client.waitForFinish(session.agentId, 30_000);
      await page.addInitScript(() => {
        localStorage.setItem(
          "panel-state",
          JSON.stringify({ state: { explorerShowHiddenFiles: false }, version: 0 }),
        );
      });
      await openAgentRoute(page, session);
      await openReportedFolderLink(page, "Open folder");
      await expectFolderContents(page);
    } finally {
      await page.screenshot({ path: test.info().outputPath("folder-link-result.png") });
      await session.cleanup();
    }
  });
}
