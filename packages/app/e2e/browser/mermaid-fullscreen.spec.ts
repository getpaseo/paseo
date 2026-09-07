import { test } from "../support/fixtures";
import {
  closeDiagramFullscreen,
  closeDiagramFullscreenFromOutside,
  expectCompletedDiagram,
  expectFullscreenDiagram,
  expectFullscreenDiagramClosed,
  openDiagramFullscreen,
  requestDiagram,
  waitForDiagramTurnToComplete,
  zoomAndPanFullscreenDiagram,
} from "../support/helpers/diagram";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const MERMAID_DIAGRAM = [
  "```mermaid",
  "flowchart LR",
  "  Start --> Middle",
  "  Middle --> Review",
  "  Review --> Ship",
  "```",
].join("\n");

test("opens a Mermaid diagram fullscreen and closes it again", async ({ page }) => {
  test.setTimeout(120_000);

  const agent = await seedMockAgentWorkspace({
    repoPrefix: "mermaid-fullscreen-",
    title: "Fullscreen Mermaid",
    featureValues: {
      mockStreamingAssistantResponse: MERMAID_DIAGRAM,
      mockStreamingAssistantIntervalMs: 10,
    },
  });
  try {
    await test.step("Open the conversation and wait for the rendered diagram", async () => {
      await openAgentRoute(page, agent);
      await requestDiagram(agent);
      await waitForDiagramTurnToComplete(agent);
      await expectCompletedDiagram(page, ["Start", "Ship"]);
    });

    await test.step("The toolbar opens the diagram fullscreen", async () => {
      await openDiagramFullscreen(page);
      await expectFullscreenDiagram(page, ["Start", "Review", "Ship"]);
    });

    await test.step("The fullscreen diagram zooms with the wheel and pans by dragging", async () => {
      await zoomAndPanFullscreenDiagram(page);
    });

    await test.step("The close action returns to the conversation", async () => {
      await closeDiagramFullscreen(page);
      await expectFullscreenDiagramClosed(page);
      await expectCompletedDiagram(page, ["Start", "Ship"]);
    });

    await test.step("Escape closes the fullscreen diagram", async () => {
      await openDiagramFullscreen(page);
      await expectFullscreenDiagram(page, ["Start", "Ship"]);
      await page.keyboard.press("Escape");
      await expectFullscreenDiagramClosed(page);
    });

    await test.step("Clicking outside the diagram closes the fullscreen viewer", async () => {
      await openDiagramFullscreen(page);
      await expectFullscreenDiagram(page, ["Start", "Ship"]);
      await closeDiagramFullscreenFromOutside(page);
      await expectFullscreenDiagramClosed(page);
    });
  } finally {
    await agent.cleanup();
  }
});
