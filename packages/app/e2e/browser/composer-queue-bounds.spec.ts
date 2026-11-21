import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  fillComposerDraft,
  sendDraftToQueue,
  startRunningMockAgent,
} from "../support/helpers/composer";
import { queueTrackMaxHeight } from "@/composer/queue-track-metrics";

const QUEUED_COUNT = 8;

async function queueMessage(page: Page, prompt: string): Promise<void> {
  await fillComposerDraft(page, prompt);
  await sendDraftToQueue(page);
}

test("a long queue is bounded and scrolls instead of growing without end", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const agent = await startRunningMockAgent(page, {
    prefix: `queue-bounds-${testInfo.workerIndex}-`,
    model: "one-minute-stream",
    prompt: "Keep the agent running while messages queue.",
  });

  try {
    for (let index = 1; index <= QUEUED_COUNT; index += 1) {
      await queueMessage(page, `queued message ${index}`);
    }

    // Every queued message survives — the cap is visual only, it must not drop work.
    await expect(page.getByRole("button", { name: "Send queued message now" })).toHaveCount(
      QUEUED_COUNT,
    );

    const track = page.getByTestId("composer-queue-track");
    await expect(track).toBeVisible();

    const cap = queueTrackMaxHeight({ spacing: 8, borderWidth: 1 });
    const box = await track.boundingBox();
    expect(box).not.toBeNull();
    // Eight rows would exceed the cap if the list still grew freely.
    expect(box?.height ?? 0).toBeLessThanOrEqual(cap + 1);

    // ...and the overflow stays reachable rather than being clipped away.
    const scroll = page.getByTestId("composer-queue-scroll");
    const overflow = await scroll.evaluate(
      (node: HTMLElement) => node.scrollHeight - node.clientHeight,
    );
    expect(overflow).toBeGreaterThan(0);

    // The message that goes in next stays pinned at the top; no auto-scroll.
    const scrollTop = await scroll.evaluate((node: HTMLElement) => node.scrollTop);
    expect(scrollTop).toBe(0);
    await expect(track.getByText("queued message 1")).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});
