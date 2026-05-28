import { expect, type Page } from "@playwright/test";

const NEAR_BOTTOM_THRESHOLD_PX = 72;

export interface ScrollMetrics {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
  distanceFromBottom: number;
}

function getVisibleChatScroll(page: Page) {
  return page.locator('[data-testid="agent-chat-scroll"]:visible').first();
}

export async function readScrollMetrics(page: Page): Promise<ScrollMetrics> {
  return getVisibleChatScroll(page).evaluate((root: Element) => {
    const candidates = [root, ...Array.from(root.querySelectorAll("*"))]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element) => {
        const tagName = element.tagName.toLowerCase();
        const isEditable =
          tagName === "textarea" ||
          tagName === "input" ||
          element.getAttribute("contenteditable") === "true";
        return !isEditable && element.scrollHeight - element.clientHeight > 1;
      });
    const scrollElement =
      candidates.sort(
        (left, right) =>
          right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight),
      )[0] ?? (root as HTMLElement);

    const offsetY = Math.max(0, scrollElement.scrollTop);
    const contentHeight = Math.max(0, scrollElement.scrollHeight);
    const viewportHeight = Math.max(0, scrollElement.clientHeight);
    const distanceFromBottom = Math.max(0, contentHeight - (offsetY + viewportHeight));

    return {
      offsetY,
      contentHeight,
      viewportHeight,
      distanceFromBottom,
    };
  });
}

export async function expectNearBottom(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const metrics = await readScrollMetrics(page);
      return metrics.distanceFromBottom;
    })
    .toBeLessThanOrEqual(NEAR_BOTTOM_THRESHOLD_PX);
}

export async function waitForContentGrowth(
  page: Page,
  previousContentHeight: number,
): Promise<ScrollMetrics> {
  await expect
    .poll(async () => {
      const metrics = await readScrollMetrics(page);
      return metrics.contentHeight;
    })
    .toBeGreaterThan(previousContentHeight);
  return readScrollMetrics(page);
}
