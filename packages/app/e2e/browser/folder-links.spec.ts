import { createServer } from "node:http";
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

test("chat web links fall back externally on web without changing file links", async ({ page }) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<h1>Chat link destination</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Link target did not listen");
  const url = `http://127.0.0.1:${address.port}/chat`;
  const session = await seedMockAgentWorkspace({
    repoPrefix: "chat-web-links-",
    title: "Chat web links",
    initialPrompt: "Show links",
    featureValues: { mockAssistantResponse: `[Open web](${url}) and [Open file](guide.md).` },
  });
  try {
    await writeFile(path.join(session.cwd, "guide.md"), "# Chat file still opens\n");
    await session.client.waitForFinish(session.agentId, 30_000);
    await openAgentRoute(page, session);
    const link = page
      .getByTestId("assistant-message")
      .getByRole("link", { name: "Open web", exact: true });
    const defaultPopup = page.waitForEvent("popup");
    await link.click();
    const external = await defaultPopup;
    await expect(external.getByRole("heading", { name: "Chat link destination" })).toBeVisible();
    await external.close();

    await page.evaluate(() => {
      const key = "@paseo:app-settings";
      const current = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...current, chatLinkBehavior: "in-app" }));
    });
    await page.reload();
    const fallbackPopup = page.waitForEvent("popup");
    await link.click();
    const fallback = await fallbackPopup;
    await expect(fallback.getByRole("heading", { name: "Chat link destination" })).toBeVisible();
    await fallback.close();
    const modifiedPopup = page.context().waitForEvent("page");
    await link.click({ modifiers: ["ControlOrMeta"] });
    const modified = await modifiedPopup;
    await expect(modified.getByRole("heading", { name: "Chat link destination" })).toBeVisible();
    await modified.close();

    await page
      .getByTestId("assistant-message")
      .getByRole("link", { name: "Open file", exact: true })
      .click();
    await expect(page.getByText("Chat file still opens", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("chat-web-links-browser.png") });
  } finally {
    await session.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
