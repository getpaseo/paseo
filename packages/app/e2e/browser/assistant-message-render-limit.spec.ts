import { expect, test } from "../support/fixtures";
import { getUtf8ByteLength } from "../../src/components/assistant-message-render-limit";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("caps a newline-heavy assistant message before rendering markdown", async ({ page }) => {
  const hiddenTail = "HIDDEN_OVERSIZED_MESSAGE_TAIL";
  const response = `${"x\n".repeat(16_000)}${hiddenTail}`;
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-message-render-limit-",
    title: "Assistant message render limit",
    initialPrompt: "Render the configured oversized response.",
    featureValues: { mockAssistantResponse: response },
  });

  try {
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);

    const assistantMessage = page.getByTestId("assistant-message").last();
    await expect(assistantMessage).toBeVisible({ timeout: 30_000 });
    await expect(assistantMessage).not.toContainText(hiddenTail);

    const notice = assistantMessage.getByTestId("assistant-message-capped-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(
      `This message was capped (${getUtf8ByteLength(response)} bytes).`,
    );
    await expect(notice).toHaveCSS("font-style", "italic");
  } finally {
    await agent.cleanup();
  }
});
