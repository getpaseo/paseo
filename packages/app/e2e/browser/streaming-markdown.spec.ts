import { test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  expectCompletedMarkdown,
  expectUnfinishedBold,
  expectUnfinishedLink,
  requestStreamingMarkdown,
} from "../support/helpers/streaming-markdown";

test("formats unfinished Markdown while streaming and preserves the completed rendering", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
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
    await requestStreamingMarkdown(agent);
    await expectUnfinishedBold(page);
    await expectUnfinishedLink(page);
    await testInfo.attach("unfinished-link", {
      body: await page.screenshot({ path: testInfo.outputPath("unfinished-link.png") }),
      contentType: "image/png",
    });
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectCompletedMarkdown(page);
    await testInfo.attach("completed-markdown", {
      body: await page.screenshot({ path: testInfo.outputPath("completed-markdown.png") }),
      contentType: "image/png",
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectCompletedMarkdown(page);
  } finally {
    await agent.cleanup();
  }
});
