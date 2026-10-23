import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";
import { ensureWorkspaceAgentPaneVisible } from "../support/helpers/workspace-tabs";

async function openMarkdownPreview(page: Page) {
  await openFileExplorer(page);
  await openFileFromExplorer(page, "README.md");
  await expectFileTabOpen(page, "README.md");
  await page
    .getByTestId("file-panel-bar")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await ensureWorkspaceAgentPaneVisible(page);
}

async function followPreviewLink(page: Page, name: string) {
  await page
    .getByTestId("workspace-file-pane")
    .filter({ visible: true })
    .getByRole("link", { name, exact: true })
    .click();
}

test("Markdown preview folder links reveal Files and file links still open a file", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "preview-folder-links-" });
  await mkdir(path.join(workspace.repoPath, "docs/guides"), { recursive: true });
  await writeFile(
    path.join(workspace.repoPath, "docs/guides/guide.md"),
    "# Folder link destination\n",
  );
  await writeFile(
    path.join(workspace.repoPath, "README.md"),
    "[Dot](./docs/guides)\n\n[Bare](docs/guides)\n\n[Guide](docs/guides/guide.md)\n",
  );
  await workspace.navigateTo();

  await openMarkdownPreview(page);
  await followPreviewLink(page, "Guide");
  await expect(page.getByText("Folder link destination", { exact: true })).toBeVisible();

  await openMarkdownPreview(page);
  await followPreviewLink(page, "Dot");
  await expectFolderContents(page);
  await expect(page.getByTestId("workspace-tab-file_docs/guides")).toHaveCount(0);

  await openMarkdownPreview(page);
  await followPreviewLink(page, "Bare");
  await expectFolderContents(page);
  await expect(page.getByTestId("workspace-tab-file_docs/guides")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("preview-folder-links.png") });
});

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
