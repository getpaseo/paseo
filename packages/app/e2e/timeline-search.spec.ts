import { test, expect } from "./fixtures";
import { awaitToolCall, expectAgentIdle } from "./helpers/agent-stream";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

const OUTPUT_QUERY = "userIsAtBottom";
const ACTIVE_MATCH_BACKGROUND = "rgb(217, 119, 6)";

function findOutputMatchSpans() {
  return Array.from(document.querySelectorAll("span"))
    .filter((element) => element.textContent === "userIsAtBottom")
    .map((element) => {
      const { backgroundColor, color } = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { backgroundColor, color, top: rect.top, bottom: rect.bottom };
    });
}

test.describe("Timeline search", () => {
  test("filters tool output, distinguishes the active match, and reveals it below the find panel", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "timeline-search-e2e-",
      title: "Timeline search regression",
      model: "ten-second-stream",
      initialPrompt: "Emit the deterministic mock tool sequence for timeline search.",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
      await expectAgentIdle(page);
      await awaitToolCall(page, "bash");

      await page.keyboard.press("Control+f");
      const panel = page.getByTestId("timeline-search-panel");
      const input = page.getByTestId("timeline-search-input");
      await expect(panel).toBeVisible();
      await input.fill(OUTPUT_QUERY);
      await page.getByTestId("timeline-search-filter-toolOutput").click();
      await expect(page.getByText("2 matches", { exact: true })).toBeVisible();

      await expect.poll(() => page.evaluate(findOutputMatchSpans)).toHaveLength(2);

      const firstSelection = await page.evaluate(findOutputMatchSpans);
      expect(new Set(firstSelection.map((match) => match.backgroundColor)).size).toBe(2);

      const chat = page.getByTestId("agent-chat-scroll").first();
      const panelBox = await panel.boundingBox();
      const chatBox = await chat.boundingBox();
      const active = firstSelection.find(
        (match) => match.backgroundColor === ACTIVE_MATCH_BACKGROUND,
      );
      expect(panelBox).not.toBeNull();
      expect(chatBox).not.toBeNull();
      expect(active).toBeDefined();
      expect(active?.top).toBeGreaterThanOrEqual(panelBox!.y + panelBox!.height);
      expect(active?.bottom).toBeLessThanOrEqual(chatBox!.y + chatBox!.height);

      await page.getByTestId("timeline-search-next").click();
      await expect.poll(() => page.evaluate(findOutputMatchSpans)).not.toEqual(firstSelection);
      const secondSelection = await page.evaluate(findOutputMatchSpans);
      expect(new Set(secondSelection.map((match) => match.backgroundColor)).size).toBe(2);
      expect(
        secondSelection.find((match) => match.backgroundColor === ACTIVE_MATCH_BACKGROUND),
      ).toBeDefined();
    } finally {
      await agent.cleanup();
    }
  });
});
