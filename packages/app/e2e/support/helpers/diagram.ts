import { expect, type Page } from "@playwright/test";
import type { MockAgentWorkspace } from "./mock-agent";

const DIAGRAM_NAME = "Diagram";

function renderedDiagram(page: Page) {
  const diagram = page.getByRole("img", { name: DIAGRAM_NAME }).last();
  const svg = diagram.locator("iframe").contentFrame().locator("#diagram svg");
  return { diagram, svg };
}

export async function requestDiagram(agent: MockAgentWorkspace): Promise<void> {
  await agent.client.sendAgentMessage(agent.agentId, "Render the requested Mermaid diagram.");
}

export async function expectDiagramWithLabels(
  page: Page,
  labels: readonly string[],
): Promise<void> {
  const { diagram, svg } = renderedDiagram(page);
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  await expect(svg).toBeVisible({ timeout: 30_000 });
  for (const label of labels) {
    await expect(svg).toContainText(label);
  }
}

export async function expectDiagramRemainsRenderedWhileStreaming(
  page: Page,
  completion: Promise<void>,
): Promise<void> {
  const diagram = page.getByRole("img", { name: DIAGRAM_NAME }).last();
  let turnCompleted = false;
  const completed = completion.then(() => {
    turnCompleted = true;
    return true;
  });
  for (;;) {
    expect(await diagram.isVisible()).toBe(true);
    if (turnCompleted) return completion;
    const box = await diagram.boundingBox();
    if (turnCompleted) return completion;
    expect(box, "the inline diagram should have measurable layout").not.toBeNull();
    expect(
      box?.height,
      "the inline diagram should remain tall enough to read",
    ).toBeGreaterThanOrEqual(56);
    const didComplete = await Promise.race([completed, page.waitForTimeout(16).then(() => false)]);
    if (didComplete) return completion;
  }
}

export async function waitForDiagramTurnToComplete(agent: MockAgentWorkspace): Promise<void> {
  await agent.client.waitForFinish(agent.agentId, 30_000);
}

export async function expectCompletedDiagram(page: Page, labels: readonly string[]): Promise<void> {
  await expectDiagramWithLabels(page, labels);
}

export async function reloadConversation(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
}

const FULLSCREEN_VIEWPORT = "mermaid-fullscreen-viewport";

function diagramSvg(page: Page, viewportTestId: string) {
  return page
    .getByTestId(`${viewportTestId}-canvas`)
    .last()
    .locator("iframe")
    .contentFrame()
    .locator("#diagram svg");
}

/**
 * The viewport toolbar only reveals itself on hover, so the diagram is hovered first. The
 * pointer is parked elsewhere beforehand so the hover transition fires even when a previous
 * step left the cursor inside the viewport.
 */
export async function openDiagramFullscreen(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.getByTestId("mermaid-viewport-canvas").last().hover();
  await page.getByTestId("mermaid-fullscreen").last().click();
}

export async function closeDiagramFullscreen(page: Page): Promise<void> {
  await page.getByTestId(`${FULLSCREEN_VIEWPORT}-canvas`).hover();
  await page.getByTestId("mermaid-fullscreen-close").click();
}

export async function zoomAndPanFullscreenDiagram(page: Page): Promise<void> {
  const canvas = page.getByTestId(`${FULLSCREEN_VIEWPORT}-canvas`);
  const svg = diagramSvg(page, FULLSCREEN_VIEWPORT);
  const initial = await svg.boundingBox();
  expect(initial, "the fullscreen diagram should have measurable layout").not.toBeNull();

  await page.mouse.move(initial!.x + initial!.width / 2, initial!.y + initial!.height / 2);
  await page.mouse.wheel(0, -100);

  const zoomed = await svg.boundingBox();
  expect(zoomed, "the zoomed diagram should have measurable layout").not.toBeNull();
  expect(zoomed!.width).toBeGreaterThan(initial!.width * 1.1);

  const viewport = await canvas.boundingBox();
  expect(viewport, "the fullscreen viewport should have measurable layout").not.toBeNull();
  await page.mouse.move(viewport!.x + viewport!.width / 2, viewport!.y + viewport!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    viewport!.x + viewport!.width / 2 - 120,
    viewport!.y + viewport!.height / 2,
  );
  await page.mouse.up();

  const panned = await svg.boundingBox();
  expect(panned, "the panned diagram should have measurable layout").not.toBeNull();
  expect(Math.abs(panned!.x - zoomed!.x)).toBeGreaterThan(100);
}

export async function closeDiagramFullscreenFromOutside(page: Page): Promise<void> {
  const canvas = page.getByTestId(`${FULLSCREEN_VIEWPORT}-canvas`);
  const viewport = await canvas.boundingBox();
  const svg = await diagramSvg(page, FULLSCREEN_VIEWPORT).boundingBox();
  expect(viewport, "the fullscreen viewport should have measurable layout").not.toBeNull();
  expect(svg, "the fullscreen diagram should have measurable layout").not.toBeNull();

  const x = viewport!.x + viewport!.width / 2;
  const y =
    svg!.y + svg!.height < viewport!.y + viewport!.height - 8
      ? viewport!.y + viewport!.height - 4
      : viewport!.y + 4;
  await page.mouse.click(x, y);
}

export async function expectFullscreenDiagram(
  page: Page,
  labels: readonly string[],
): Promise<void> {
  const viewport = page.getByTestId(FULLSCREEN_VIEWPORT);
  await expect(viewport).toBeVisible({ timeout: 30_000 });
  const svg = diagramSvg(page, FULLSCREEN_VIEWPORT);
  await expect(svg).toBeVisible({ timeout: 30_000 });
  for (const label of labels) {
    await expect(svg).toContainText(label);
  }
}

export async function expectFullscreenDiagramClosed(page: Page): Promise<void> {
  await expect(page.getByTestId(FULLSCREEN_VIEWPORT)).toHaveCount(0);
}
