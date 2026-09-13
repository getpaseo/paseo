import { expect, type Page, type TestInfo } from "@playwright/test";
import { openAgentRoute, seedMockAgentWorkspace, type MockAgentWorkspace } from "./mock-agent";

export async function withStreamingMarkdown(
  page: Page,
  testInfo: TestInfo,
  run: (agent: MockAgentWorkspace) => Promise<void>,
): Promise<void> {
  testInfo.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "streaming-markdown-",
    title: "Streaming Markdown",
    featureValues: {
      mockStreamingAssistantResponse:
        "**Bold text stays bold** and [Paseo docs](https://example.com/documentation). Done.",
      mockStreamingAssistantIntervalMs: 400,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await run(agent);
  } finally {
    await agent.cleanup();
  }
}

export async function requestStreamingMarkdown(agent: MockAgentWorkspace): Promise<void> {
  await agent.client.sendAgentMessage(agent.agentId, "Show the formatted streaming response.");
}

export async function expectUnfinishedBold(page: Page): Promise<void> {
  const message = page.getByTestId("assistant-message").last();
  const bold = message.locator('[data-paseo-markdown-tag="strong"]');
  await expect(bold).toContainText("Bold");
  await expect(message).not.toContainText("stays bold");
  await expect(bold).toHaveCSS("font-weight", "500");
  await expect(message).not.toContainText("*");
}

export async function expectUnfinishedLink(page: Page, testInfo: TestInfo): Promise<void> {
  const message = page.getByTestId("assistant-message").last();
  await expect(message).toContainText("Paseo docs");
  await expect(message.getByRole("link", { name: "Paseo docs" })).toHaveCount(0);
  await expect(message).not.toContainText("[");
  await expect(message).not.toContainText("https:");
  await captureMarkdown(page, testInfo, "unfinished-link");
}

export async function expectFinishedMarkdown(
  page: Page,
  agent: MockAgentWorkspace,
  testInfo: TestInfo,
): Promise<void> {
  await agent.client.waitForFinish(agent.agentId, 30_000);
  await expectCompletedMarkdown(page);
  await captureMarkdown(page, testInfo, "completed-markdown");
}

export async function expectReloadedMarkdown(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectCompletedMarkdown(page);
}

async function captureMarkdown(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
    contentType: "image/png",
  });
}

async function expectCompletedMarkdown(page: Page): Promise<void> {
  const message = page.getByTestId("assistant-message").last();
  await expect(message).toHaveText("Bold text stays bold and Paseo docs. Done.");
  await expect(
    message.getByRole("link", { name: "Paseo docs" }).and(message.locator("a")),
  ).toHaveAttribute("href", "https://example.com/documentation");
  await expect(message.locator('[data-paseo-markdown-tag="strong"]')).toHaveCSS(
    "font-weight",
    "500",
  );
}
