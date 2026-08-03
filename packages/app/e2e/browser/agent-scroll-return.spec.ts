import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import {
  readScrollMetrics,
  scrollChatAwayFromBottom,
} from "../support/helpers/agent-bottom-anchor";
import { getServerId } from "../support/helpers/server-id";
import { seedMockAgentWorkspace, type MockAgentWorkspace } from "../support/helpers/mock-agent";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";
import {
  expectTimelinePromptVisible,
  openAgentTimeline,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";

async function expectChatAtBottom(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readScrollMetrics(page)).distanceFromBottom, {
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(72);
}

async function openCompactWorkspace(
  page: Page,
  workspace: Pick<MockAgentWorkspace, "workspaceId">,
): Promise<void> {
  await openMobileAgentSidebar(page);
  await switchWorkspaceViaSidebar({
    page,
    serverId: getServerId(),
    workspaceId: workspace.workspaceId,
  });
}

function armDelayedScrollForHiddenChat(page: Page): Promise<void> {
  return page
    .locator('[data-testid="agent-chat-scroll"]:visible')
    .first()
    .evaluate((root) => {
      const scroll = root as HTMLElement;
      return new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => {
          if (scroll.getClientRects().length > 0) return;
          observer.disconnect();
          scroll.dispatchEvent(new Event("scroll"));
          resolve();
        });
        observer.observe(scroll);
      });
    });
}

test("a stationary pointer cannot turn geometry changes into scroll intent", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const backgroundPrompt = "Continue after a pointer is released outside the chat";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
    const bounds = await scroll.boundingBox();
    expect(bounds, "Expected visible chat scroll bounds").not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.setViewportSize({ width: 390, height: 1124 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.mouse.move(410, bounds!.y + bounds!.height / 2);
    await page.mouse.up();

    await longChat.client.sendAgentMessage(longChat.agentId, backgroundPrompt);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
  } finally {
    await longChat.cleanup();
  }
});

test("a retained chat ignores delayed scroll delivery while hidden", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-hidden-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });
  const backgroundPrompt = "emit 500 coalesced agent stream updates";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    const delayedScrollDelivered = armDelayedScrollForHiddenChat(page);
    await openCompactWorkspace(page, otherWorkspace);
    await delayedScrollDelivered;
    await longChat.client.sendAgentMessage(longChat.agentId, backgroundPrompt);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);

    await openCompactWorkspace(page, longChat);
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("a retained streaming chat returns to the bottom and continues following", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-streaming-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });
  const streamingPrompt = "Continue streaming while this workspace is hidden";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    await longChat.client.sendAgentMessage(longChat.agentId, streamingPrompt);
    await longChat.client.waitForAgentUpsert(
      longChat.agentId,
      (snapshot) => snapshot.status === "running",
      15_000,
    );
    await openCompactWorkspace(page, otherWorkspace);
    await openCompactWorkspace(page, longChat);

    await expectTimelinePromptVisible(page, streamingPrompt);
    await expectChatAtBottom(page);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);
    await expectChatAtBottom(page);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("a retained chat preserves an intentional reading position", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-reading-position-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    const readingPosition = await scrollChatAwayFromBottom(page, {
      deltaY: -900,
      minDistanceFromBottom: 300,
    });

    await openCompactWorkspace(page, otherWorkspace);
    await openCompactWorkspace(page, longChat);

    await expect
      .poll(async () => Math.abs((await readScrollMetrics(page)).offsetY - readingPosition.offsetY))
      .toBeLessThanOrEqual(24);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});
