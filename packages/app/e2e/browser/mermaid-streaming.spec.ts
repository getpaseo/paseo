import { test } from "../support/fixtures";
import {
  expectCompletedDiagram,
  expectDiagramRemainsRenderedWhileStreaming,
  expectDiagramWithLabels,
  reloadConversation,
  requestDiagram,
  waitForDiagramTurnToComplete,
} from "../support/helpers/diagram";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const STREAMED_MERMAID = [
  "```mermaid",
  "flowchart LR",
  "  Start --> Middle",
  '  Middle --> Done["<i>Done</i>"]',
  "  Middle --> Review",
  "  Review --> Verify",
  "  Verify --> Ship",
  "  Ship --> Package",
  "  Package --> Sign",
  "  Sign --> Upload",
  "  Upload --> Publish",
  "  Publish --> Deploy",
  "  Deploy --> Observe",
  "  Observe --> Validate",
  "  Validate --> Announce",
  "  Announce --> Document",
  "  Document --> Archive",
  "  Archive --> Release",
  "```",
].join("\n");

test("keeps a Mermaid diagram rendered while its message streams, completes, and reloads", async ({
  page,
}) => {
  test.setTimeout(90_000);

  const agent = await seedMockAgentWorkspace({
    repoPrefix: "mermaid-streaming-",
    title: "Streaming Mermaid",
    featureValues: {
      mockStreamingAssistantResponse: STREAMED_MERMAID,
      mockStreamingAssistantIntervalMs: 150,
    },
  });
  try {
    await test.step("Open the conversation and request a diagram", async () => {
      await openAgentRoute(page, agent);
      await requestDiagram(agent);
    });

    await test.step("The diagram renders and stays rendered while tokens arrive", async () => {
      await expectDiagramWithLabels(page, ["Start", "Middle"]);
      await expectDiagramRemainsRenderedWhileStreaming(page);
    });

    await test.step("The completed diagram shows the final streamed content", async () => {
      await waitForDiagramTurnToComplete(agent);
      await expectCompletedDiagram(page, ["Start", "Done", "Release"]);
    });

    await test.step("The completed diagram remains rendered after reload", async () => {
      await reloadConversation(page);
      await expectCompletedDiagram(page, ["Start", "Done", "Release"]);
    });
  } finally {
    await agent.cleanup();
  }
});
