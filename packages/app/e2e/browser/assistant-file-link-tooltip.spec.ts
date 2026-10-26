import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

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
