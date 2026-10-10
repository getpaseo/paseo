import { holdAssistantStream } from "./agent-timeline-gate";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { openAgentRoute, seedMockAgentWorkspace, type MockAgentWorkspace } from "./mock-agent";

interface StreamingMarkdownAgent extends MockAgentWorkspace {
  stream: Awaited<ReturnType<typeof holdAssistantStream>>;
}

export async function withStreamingMarkdown(
  page: Page,
  testInfo: TestInfo,
  run: (agent: StreamingMarkdownAgent) => Promise<void>,
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
  const stream = await holdAssistantStream(page, agent.agentId);
  try {
    await openAgentRoute(page, agent);
    await stream.waitForInitialTimeline();
    await run({ ...agent, stream });
  } finally {
    stream.release();
    await agent.cleanup();
  }
}

export async function requestStreamingMarkdown(agent: StreamingMarkdownAgent): Promise<void> {
  await agent.client.sendAgentMessage(agent.agentId, "Show the formatted streaming response.");
  // Exercise late assertions: the producer finishes before the browser consumes its frames.
  await agent.client.waitForFinish(agent.agentId, 30_000);
  // The mock splits "**Bold" into two frames. Whether they land in one store
  // commit or two is up to the browser's task scheduling, and word pacing only
  // releases a word once the whitespace after it has arrived, so stop after
  // that whitespace: every batching then reveals "Bold" and nothing past "text".
  await agent.stream.showThrough("**Bold text");
}

export async function expectUnfinishedBold(page: Page): Promise<void> {
  const message = page.getByTestId("assistant-message").last();
  const bold = message.locator('[data-paseo-markdown-tag="strong"]');
  await expect(bold).toContainText("Bold");
  await expect(message).not.toContainText("stays bold");
  await expect(bold).toHaveCSS("font-weight", "500");
  await expect(message).not.toContainText("*");
}

export async function expectUnfinishedLink(
  page: Page,
  agent: StreamingMarkdownAgent,
  testInfo: TestInfo,
): Promise<void> {
  const message = page.getByTestId("assistant-message").last();
  await agent.stream.showThrough("**Bold text stays bold** and [Paseo docs");
  await expect(message).toContainText("Paseo docs");
  await expect(message.getByRole("link", { name: "Paseo docs" })).toHaveCount(0);
  await expect(message).not.toContainText("[");
  await expect(message).not.toContainText("https:");
  await captureMarkdown(page, testInfo, "unfinished-link");
}

export async function expectFinishedMarkdown(
  page: Page,
  agent: StreamingMarkdownAgent,
  testInfo: TestInfo,
): Promise<void> {
  agent.stream.release();
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
