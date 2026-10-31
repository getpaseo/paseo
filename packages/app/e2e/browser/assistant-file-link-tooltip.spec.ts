import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openFilesPanel } from "../support/helpers/workspace-tabs";

async function readFileLinkTooltip(page: Page): Promise<void> {
  const link = page.getByRole("link", { name: "the guide", exact: true });
  await link.hover();
  await expect(page.getByRole("tooltip")).toContainText("guide.md");
}

async function leaveFileLink(page: Page): Promise<void> {
  await page.mouse.move(5, 5);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}

async function openLinkedFile(page: Page): Promise<void> {
  await page.getByRole("link", { name: "the guide", exact: true }).click();
  await expect(page.getByTestId("markdown-preview-frame")).toContainText("Example guide");
  await leaveFileLink(page);
}

async function returnToAgent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Tooltip regression", exact: true }).click();
  await expect(page.getByRole("link", { name: "the guide", exact: true })).toBeVisible();
  await leaveFileLink(page);
}

async function switchToFileTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "guide.md", exact: true }).click();
  await expect(page.getByTestId("markdown-preview-frame")).toContainText("Example guide");
  await leaveFileLink(page);
}

test("opening an assistant file link dismisses its tooltip over the file tab", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "tooltip-5811-",
    title: "Tooltip regression",
    featureValues: {
      mockStreamingAssistantResponse: "Read [the guide](./guide.md).",
      mockStreamingAssistantIntervalMs: 5,
    },
  });
  try {
    await writeFile(
      path.join(agent.cwd, "guide.md"),
      "# Example guide\n\n" + "Plain paragraph.\n\n".repeat(150),
    );
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Show the file link.");
    await agent.client.waitForFinish(agent.agentId, 30_000);

    await readFileLinkTooltip(page);
    await leaveFileLink(page);
    await readFileLinkTooltip(page);
    await openLinkedFile(page);
    await returnToAgent(page);
    await readFileLinkTooltip(page);
    await switchToFileTab(page);
    await returnToAgent(page);
    await readFileLinkTooltip(page);
    await leaveFileLink(page);
  } finally {
    await agent.cleanup();
  }
});

test("assistant file links reveal and select nested files in Explorer", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-file-selection-",
    title: "File selection regression",
    repo: {
      files: [
        { path: "docs/guides/guide.md", content: "# Nested guide\n" },
        { path: "docs/guides/.notes.md", content: "# Hidden notes\n" },
      ],
    },
    featureValues: {
      mockStreamingAssistantResponse:
        "Read [the nested guide](./docs/guides/guide.md) and [hidden notes](./docs/guides/.notes.md).",
      mockStreamingAssistantIntervalMs: 5,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await openFilesPanel(page);
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await expect(page.getByTestId("file-explorer-tree-scroll")).not.toBeVisible();
    await agent.client.sendAgentMessage(agent.agentId, "Show the file links.");
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await page.screenshot({ path: testInfo.outputPath("before-chat-file-link.png") });

    await page.getByRole("link", { name: "the nested guide", exact: true }).click();
    await expect(page.getByTestId("markdown-preview-frame")).toContainText("Nested guide");
    const tree = page.getByTestId("file-explorer-tree-scroll");
    await expect(tree).toBeVisible();
    const guideRow = tree
      .getByText("guide.md", { exact: true })
      .locator("xpath=ancestor::*[starts-with(@data-testid, 'file-explorer-row-')][1]");
    await expect(guideRow).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: testInfo.outputPath("after-chat-file-link.png") });

    await page.getByTestId("files-hidden-toggle").click();
    await expect(tree.getByText(".notes.md", { exact: true })).not.toBeVisible();
    await page.getByRole("button", { name: "File selection regression", exact: true }).click();
    await page.getByRole("link", { name: "hidden notes", exact: true }).click();
    await expect(
      page.getByTestId("markdown-preview-frame").filter({ visible: true }),
    ).toContainText("Hidden notes");
    const notesRow = tree
      .getByText(".notes.md", { exact: true })
      .locator("xpath=ancestor::*[starts-with(@data-testid, 'file-explorer-row-')][1]");
    await expect(notesRow).toHaveAttribute("aria-selected", "true");
    await expect(guideRow).toHaveAttribute("aria-selected", "false");
  } finally {
    await agent.cleanup();
  }
});

test("assistant file links scroll selected files into view", async ({ page }, testInfo) => {
  testInfo.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-file-scroll-",
    title: "File scroll regression",
    repo: {
      files: [
        ...Array.from({ length: 150 }, (_, index) => ({
          path: `docs/file-${String(index).padStart(3, "0")}.md`,
          content: "Example file\n",
        })),
        { path: "docs/target.md", content: "# Scroll target\n" },
      ],
    },
    featureValues: {
      mockStreamingAssistantResponse: "Read [the target](./docs/target.md).",
      mockStreamingAssistantIntervalMs: 5,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Show the file link.");
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await page.getByRole("link", { name: "the target", exact: true }).click();
    await expect(page.getByTestId("markdown-preview-frame")).toContainText("Scroll target");
    const selectedRow = page
      .getByTestId("file-explorer-tree-scroll")
      .locator('[aria-selected="true"]');
    await expect(selectedRow).toContainText("target.md");
    await expect(selectedRow).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("after-scroll-to-linked-file.png") });

    await page.getByTestId("file-explorer-tree-scroll").hover();
    await page.mouse.wheel(0, -10_000);
    await expect(selectedRow).not.toBeInViewport();
    await page.getByRole("button", { name: "File scroll regression", exact: true }).click();
    await page.getByRole("link", { name: "the target", exact: true }).click();
    await expect(selectedRow).toBeInViewport();
    await page.getByTestId("files-new-file").click();
    const nameInput = page.getByTestId("file-explorer-name-input");
    await expect(nameInput).toBeInViewport();
    await nameInput.press("Escape");
  } finally {
    await agent.cleanup();
  }
});

test("file links outside the workspace preserve Explorer selection", async ({ page }, testInfo) => {
  testInfo.setTimeout(120_000);
  const outsideDirectory = await mkdtemp(path.join(tmpdir(), "chat-outside-workspace-"));
  const outsidePath = path.join(outsideDirectory, "outside.md");
  await writeFile(outsidePath, "# Outside workspace\n");
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-file-outside-",
    title: "Outside file regression",
    repo: { files: [{ path: "docs/guide.md", content: "# Workspace guide\n" }] },
    featureValues: {
      mockStreamingAssistantResponse: `Read [workspace guide](./docs/guide.md) and [outside file](${outsidePath}).`,
      mockStreamingAssistantIntervalMs: 5,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Show the file links.");
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await page.getByRole("link", { name: "workspace guide", exact: true }).click();
    const tree = page.getByTestId("file-explorer-tree-scroll");
    const selectedRow = tree.locator('[aria-selected="true"]');
    await expect(selectedRow).toContainText("guide.md");
    await page.getByRole("button", { name: "Outside file regression", exact: true }).click();
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await expect(tree).not.toBeVisible();
    await page.getByRole("link", { name: "outside file", exact: true }).click();
    await expect(
      page.getByTestId("markdown-preview-frame").filter({ visible: true }),
    ).toContainText("Outside workspace");
    await expect(tree).not.toBeVisible();
    await openFilesPanel(page);
    await expect(selectedRow).toContainText("guide.md");
  } finally {
    await agent.cleanup();
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});
