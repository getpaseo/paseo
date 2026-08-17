import { expect, type Locator, type Page } from "@playwright/test";

export interface SplitPaneGeometry {
  containerWidth: number;
  explorerWidth: number;
  visibleWidth: number;
  separatorCount: number;
  occupiedWidth: number;
}

function splitSeparator(page: Page): Locator {
  return page.getByRole("separator", { name: "" });
}

export async function openExplorerSplit(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open explorer" }).click();
  await expect(splitSeparator(page)).toHaveCount(1, { timeout: 30_000 });
}

export async function hideExplorerSplit(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close explorer" }).click();
  await expect(splitSeparator(page)).toHaveCount(0, { timeout: 30_000 });
}

export async function resizeExplorerSplit(page: Page, deltaX: number): Promise<void> {
  const separator = splitSeparator(page);
  await expect(separator).toHaveCount(1);
  const box = await separator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Split separator has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
}

export async function stampExplorerNode(page: Page): Promise<void> {
  await page
    .getByTestId("split-group-child")
    .last()
    .evaluate((node) => {
      Reflect.set(window, "__splitPaneExplorerNode", node);
      node.setAttribute("data-split-pane-identity", "retained");
    });
}

export async function expectExplorerNodeRetained(page: Page): Promise<void> {
  const stampedNode = page.locator('[data-split-pane-identity="retained"]');
  await expect(stampedNode).toHaveCount(1);
  expect(
    await stampedNode.evaluate((node) => Reflect.get(window, "__splitPaneExplorerNode") === node),
  ).toBe(true);
}

export async function measureExplorerSplit(page: Page): Promise<SplitPaneGeometry> {
  const explorerChild = page.locator('[data-split-pane-identity="retained"]');
  await expect(explorerChild).toHaveCount(1);

  return explorerChild.evaluate((explorerNode) => {
    const visibleNode = Array.from(explorerNode.parentElement?.children ?? [])
      .filter(
        (candidate) =>
          candidate !== explorerNode &&
          (candidate as HTMLElement).dataset.testid === "split-group-child",
      )
      .sort(
        (left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width,
      )[0];
    if (!(visibleNode instanceof HTMLElement)) throw new Error("Visible split child not found");
    const visible = visibleNode.getBoundingClientRect();
    const explorer = explorerNode.getBoundingClientRect();
    const container = explorerNode.parentElement?.getBoundingClientRect();
    if (!container) throw new Error("Split child has no container");
    const separatorCount =
      explorerNode.parentElement?.querySelectorAll('[role="separator"]').length ?? 0;
    return {
      containerWidth: container.width,
      explorerWidth: explorer.width,
      visibleWidth: visible.width,
      separatorCount,
      occupiedWidth: explorer.width + visible.width,
    };
  });
}
