import { expect, type Page } from "@playwright/test";

const NEAR_BOTTOM_THRESHOLD_PX = 72;
const DEFAULT_SCROLL_TOLERANCE_PX = 24;

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

export async function scrollAgentChatToBottom(page: Page): Promise<void> {
  const chatScroll = getVisibleChatScroll(page);
  await chatScroll.evaluate((root: Element) => {
    const scrollElement = root as HTMLElement;
    scrollElement.scrollTop = scrollElement.scrollHeight;
  });
  await expect
    .poll(async () =>
      chatScroll.evaluate((root: Element) => {
        const scrollElement = root as HTMLElement;
        return Math.max(
          0,
          scrollElement.scrollHeight - (scrollElement.scrollTop + scrollElement.clientHeight),
        );
      }),
    )
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

export async function waitForScrollableChat(
  page: Page,
  input: { minScrollableDistance: number; timeout?: number },
): Promise<void> {
  await expect
    .poll(
      async () => {
        const metrics = await readScrollMetrics(page);
        return metrics.contentHeight - metrics.viewportHeight;
      },
      { timeout: input.timeout },
    )
    .toBeGreaterThan(input.minScrollableDistance);
}

export async function scrollChatAwayFromBottom(
  page: Page,
  input: { deltaY: number; minDistanceFromBottom: number },
): Promise<ScrollMetrics> {
  const scroll = getVisibleChatScroll(page);
  const box = await scroll.boundingBox();
  if (!box) {
    throw new Error("Agent chat scroll container is not visible");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, input.deltaY);

  await expect
    .poll(async () => {
      const metrics = await readScrollMetrics(page);
      return metrics.distanceFromBottom;
    })
    .toBeGreaterThan(input.minDistanceFromBottom);

  return readScrollMetrics(page);
}

export async function clickToolCallBesideScrollToBottomButton(page: Page): Promise<{
  outsideButton: boolean;
  toolCallReceivesPointer: boolean;
  withinButtonBand: boolean;
}> {
  await scrollChatAwayFromBottom(page, {
    deltaY: -900,
    minDistanceFromBottom: 300,
  });

  const scrollToBottomButton = page.getByRole("button", { name: "Scroll to bottom" });
  await expect(scrollToBottomButton).toBeVisible();

  const hitArea = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="scroll-to-bottom-button"]');
    if (!(button instanceof HTMLElement)) {
      throw new Error("Expected visible scroll-to-bottom button");
    }
    const buttonBounds = button.getBoundingClientRect();
    const toolCall = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="tool-call-badge"] [role="button"]'),
    ).find((element) => {
      const bounds = element.getBoundingClientRect();
      const centerY = bounds.top + bounds.height / 2;
      return bounds.width > 0 && centerY >= buttonBounds.top && centerY <= buttonBounds.bottom;
    });
    if (!toolCall) {
      throw new Error("Expected a tool call beside the scroll-to-bottom button");
    }

    const toolCallBounds = toolCall.getBoundingClientRect();
    const clickPoint = {
      x: toolCallBounds.left + 24,
      y: toolCallBounds.top + toolCallBounds.height / 2,
    };
    const hit = document.elementFromPoint(clickPoint.x, clickPoint.y);
    return {
      clickPoint,
      outsideButton: clickPoint.x < buttonBounds.left || clickPoint.x > buttonBounds.right,
      toolCallReceivesPointer: hit !== null && toolCall.contains(hit),
      withinButtonBand: clickPoint.y >= buttonBounds.top && clickPoint.y <= buttonBounds.bottom,
    };
  });
  await page.mouse.click(hitArea.clickPoint.x, hitArea.clickPoint.y);
  return {
    outsideButton: hitArea.outsideButton,
    toolCallReceivesPointer: hitArea.toolCallReceivesPointer,
    withinButtonBand: hitArea.withinButtonBand,
  };
}

export async function expectScrollStaysFixed(
  page: Page,
  baseline: ScrollMetrics,
  input?: { durationMs?: number; sampleIntervalMs?: number; tolerancePx?: number },
): Promise<void> {
  const durationMs = input?.durationMs ?? 2_000;
  const sampleIntervalMs = input?.sampleIntervalMs ?? 250;
  const tolerancePx = input?.tolerancePx ?? DEFAULT_SCROLL_TOLERANCE_PX;
  const samples: Array<{ elapsedMs: number; offsetY: number; contentHeight: number }> = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    await page.waitForTimeout(sampleIntervalMs);
    const metrics = await readScrollMetrics(page);
    samples.push({
      elapsedMs: Date.now() - startedAt,
      offsetY: metrics.offsetY,
      contentHeight: metrics.contentHeight,
    });
    expect(
      metrics.offsetY,
      JSON.stringify({ baseline, samples: samples.slice(-12) }),
    ).toBeLessThanOrEqual(baseline.offsetY + tolerancePx);
  }
}
