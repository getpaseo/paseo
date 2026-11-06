import { expect } from "@playwright/test";
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

test("bounds a tall inline diagram", async ({ page }) => {
  test.setTimeout(120_000);
  const diagram = [
    "```mermaid",
    "flowchart TD",
    ...Array.from({ length: 30 }, (_, i) => `N${i} --> N${i + 1}`),
    "```",
  ].join("\n");
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "mermaid-tall-",
    title: "Tall Mermaid",
    featureValues: {
      mockStreamingAssistantResponse: diagram,
      mockStreamingAssistantIntervalMs: 10,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await requestDiagram(agent);
    await waitForDiagramTurnToComplete(agent);
    await expectCompletedDiagram(page, ["N0", "N30"]);
    const viewport = page.getByTestId("mermaid-viewport").last();
    expect((await viewport.boundingBox())!.height).toBe(480);
    await page.screenshot({ path: test.info().outputPath("tall-preview.png") });
    await openDiagramFullscreen(page);
    await expectFullscreenDiagram(page, ["N0", "N30"]);
    await closeDiagramFullscreen(page);
  } finally {
    await agent.cleanup();
  }
});

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

    await test.step("Source toggles preserve the iframe and exclude hidden controls", async () => {
      const viewport = page.getByTestId("mermaid-viewport").last();
      const iframe = await viewport.locator("iframe").elementHandle();
      for (let i = 0; i < 3; i++) {
        await viewport.hover();
        await page.getByRole("button", { name: "View source" }).last().click();
        const viewDiagram = page.getByRole("button", { name: "View diagram" }).last();
        if (i === 0) await page.screenshot({ path: test.info().outputPath("source.png") });
        await viewDiagram.click();
        await expect(viewDiagram).toHaveCount(0);
        if (i === 0) await page.screenshot({ path: test.info().outputPath("diagram.png") });
        await expect(page.getByTestId("mermaid-fullscreen-viewport")).toHaveCount(0);
        expect(
          await viewport.locator("iframe").evaluate((node, original) => node === original, iframe),
        ).toBe(true);
      }
      await viewport.hover();
      await page.getByRole("button", { name: "View source" }).last().click();
      await viewport.getByTestId("mermaid-fullscreen").focus();
      await expect(viewport.getByTestId("mermaid-fullscreen")).not.toBeFocused();
      await page.getByRole("button", { name: "View diagram" }).last().click();
      const box = await viewport.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(56);
      expect(box!.height).toBeLessThan(480);
      await viewport.hover();
      await page.getByRole("button", { name: "Zoom in" }).last().click();
      await expect(page.getByRole("button", { name: "Reset view" }).last()).toBeEnabled();
      await page.getByRole("button", { name: "Reset view" }).last().click();
      await expect(page.getByRole("button", { name: "Reset view" }).last()).toBeDisabled();
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
