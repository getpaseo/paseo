import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  closeCommandCenter,
  openCommandCenter,
  selectCommandCenterTab,
} from "../support/helpers/command-center";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  attachComposerTestImage,
  composerLocator,
  expectComposerDraft,
  expectComposerFocused,
  expectComposerNotFocused,
  expectComposerVisible,
  fillComposerDraft,
  submitMessage,
  submitMessageWithButton,
} from "../support/helpers/composer";
import { readReplicaCache, writeReplicaCache } from "../support/helpers/replica-cache-storage";
import {
  disconnectViewedTimeline,
  releaseHeldCatchUp,
  restoreViewedTimelineHoldingCatchUp,
} from "../support/helpers/timeline-resume";

// UI plumbing contract against the dev mock provider. Real-provider behavior is tested in `daemon-e2e/*-rewind.real.e2e.test.ts`.

async function expectUserMessageCount(page: Page, expected: number): Promise<void> {
  await expect(page.getByTestId("user-message")).toHaveCount(expected);
}

function userMessage(page: Page, text: string): Locator {
  return page.getByTestId("user-message").filter({ hasText: text });
}

async function expectUserMessageVisible(page: Page, text: string): Promise<void> {
  await expect(userMessage(page, text)).toBeVisible();
}

async function selectRewindOption(page: Page, name: string): Promise<void> {
  const option = page.getByRole("menuitem", { name, exact: true });
  // Menus mount offscreen while their anchor and content are measured.
  await expect(option).toBeInViewport({ ratio: 1 });
  await option.click();
}

async function searchRewindActions(page: Page): Promise<Locator> {
  const palette = await openCommandCenter(page);
  await selectCommandCenterTab(palette, "Actions");
  await palette.getByRole("textbox").fill("rewind last turn");
  return palette;
}

function rewindAction(palette: Locator, name: string): Locator {
  return palette.getByRole("button", { name: `${name} This action cannot be undone`, exact: true });
}

async function rewriteCachedMessageAsLegacyRow(
  page: Page,
  input: { prompt: string; agentId: string; workspaceId: string },
): Promise<void> {
  await expect
    .poll(async () => {
      const cache = await readReplicaCache(page);
      if (!cache) return false;
      for (const host of cache.hosts ?? []) {
        const hasAgent = host.agents.some(
          (agent) =>
            agent.snapshot &&
            typeof agent.snapshot === "object" &&
            Reflect.get(agent.snapshot, "id") === input.agentId,
        );
        const hasWorkspace = host.workspaces.some(
          (workspace) => workspace.id === input.workspaceId,
        );
        if (!hasAgent || !hasWorkspace) continue;
        for (const timeline of host.timelines) {
          for (const item of timeline.items ?? []) {
            if (
              timeline.agentId === input.agentId &&
              item.kind === "user_message" &&
              item.text === input.prompt &&
              item.messageId
            ) {
              return true;
            }
          }
        }
      }
      return false;
    })
    .toBe(true);

  const cache = await readReplicaCache(page);
  if (!cache) throw new Error("Replica cache was not persisted");
  const cachedMessage = cache.hosts
    ?.flatMap((host) => host.timelines.flatMap((timeline) => timeline.items ?? []))
    .find((item) => item.kind === "user_message" && item.text === input.prompt);
  if (!cachedMessage) throw new Error("Cached user message was not found");
  delete cachedMessage.messageId;
  await writeReplicaCache(page, cache);
}

async function waitForCurrentSubmissionExcludedFromCache(
  page: Page,
  prompt: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const cache = await readReplicaCache(page);
      if (!cache) return false;
      return !cache.hosts
        ?.flatMap((host) => host.timelines.flatMap((timeline) => timeline.items ?? []))
        .some(
          (item) =>
            item.kind === "user_message" &&
            item.text === prompt &&
            typeof item.clientMessageId === "string" &&
            item.messageId === undefined,
        );
    })
    .toBe(true);
}

async function waitForCachedMessageWithoutProviderId(page: Page, prompt: string): Promise<void> {
  await expect
    .poll(async () => {
      const cache = await readReplicaCache(page);
      if (!cache) return false;
      return cache.hosts
        ?.flatMap((host) => host.timelines.flatMap((timeline) => timeline.items ?? []))
        .some(
          (item) =>
            item.kind === "user_message" && item.text === prompt && item.messageId === undefined,
        );
    })
    .toBe(true);
}

async function expectPendingSubmissionNotRestoredAfterReload(page: Page): Promise<void> {
  const prompt = "Keep this cached submission pending.";
  const gate = await installDaemonWebSocketGate(page);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "rewind-current-cache-e2e-",
    title: "Current cache submission e2e",
  });

  try {
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    gate.holdNextClientRequest("send_agent_message_request");
    await submitMessage(page, prompt);
    await gate.waitForHeldClientRequest();
    await waitForCurrentSubmissionExcludedFromCache(page, prompt);
    await gate.drop();
    await page.reload();

    await expect(userMessage(page, prompt)).toHaveCount(0);
  } finally {
    gate.restore();
    await session.cleanup();
  }
}

test.describe("Rewind sheet", () => {
  test("does not restore a local-only submission from the display cache", async ({ page }) => {
    await expectPendingSubmissionNotRestoredAfterReload(page);
  });

  test("does not invent rewind identity for an ID-less cached message", async ({ page }) => {
    const prompt = "Restore this rewind identity from the legacy cache.";
    const gate = await installDaemonWebSocketGate(page);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "rewind-cache-upgrade-e2e-",
      title: "Rewind cache upgrade e2e",
      initialPrompt: prompt,
    });

    try {
      await openAgentRoute(page, session);
      await expectUserMessageVisible(page, prompt);
      await gate.drop();
      await rewriteCachedMessageAsLegacyRow(page, {
        prompt,
        agentId: session.agentId,
        workspaceId: session.workspaceId,
      });
      await page.reload();
      await waitForCachedMessageWithoutProviderId(page, prompt);

      const restoredMessage = userMessage(page, prompt);
      await expect(restoredMessage).toBeVisible();
      await restoredMessage.hover();
      await expect(restoredMessage.getByTestId("rewind-menu-trigger")).toHaveCount(0);
    } finally {
      gate.restore();
      await session.cleanup();
    }
  });

  test("rewinds from a user message sheet option", async ({ page }) => {
    const firstPrompt = "emit 1 coalesced agent stream updates for first rewind turn.";
    const secondPrompt = "Prepare deleted rewind turn assistant content.";
    const replacementPrompt = "emit 1 coalesced agent stream updates for replacement rewind turn.";
    const session = await seedMockAgentWorkspace({
      repoPrefix: "rewind-e2e-",
      title: "Rewind e2e",
      initialPrompt: firstPrompt,
      model: "ten-second-stream",
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);

      await expectUserMessageVisible(page, firstPrompt);
      await expectUserMessageCount(page, 1);
      await submitMessage(page, secondPrompt);
      await expectUserMessageVisible(page, secondPrompt);
      await expect(page.getByText("Cycle 1", { exact: true })).toBeVisible();
      await expectUserMessageCount(page, 2);
      await session.client.waitForFinish(session.agentId);

      await userMessage(page, firstPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      const rewindSheet = page.getByTestId("rewind-menu-content");
      await expect(rewindSheet).toBeVisible();
      await expect(
        rewindSheet.getByText("This action cannot be undone", { exact: true }),
      ).toBeVisible();
      await selectRewindOption(page, "Rewind conversation");

      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expect(userMessage(page, secondPrompt)).toHaveCount(0);
      await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
      await expectUserMessageCount(page, 1);
      await expectComposerDraft(page, firstPrompt);
      await expectComposerFocused(page);

      await submitMessage(page, replacementPrompt);
      await expectUserMessageVisible(page, replacementPrompt);
      await expect(userMessage(page, secondPrompt)).toHaveCount(0);
      await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
      await expectUserMessageCount(page, 2);

      await fillComposerDraft(page, "");
      await composerLocator(page).evaluate((element) => element.blur());
      await userMessage(page, replacementPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await selectRewindOption(page, "Rewind files");
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, "");
      await expectComposerNotFocused(page);
      await expectUserMessageCount(page, 2);

      await fillComposerDraft(page, "");
      await composerLocator(page).evaluate((element) => element.blur());
      await userMessage(page, replacementPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await selectRewindOption(page, "Rewind conversation and files");
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, replacementPrompt);
      await expectComposerFocused(page);
      await expectUserMessageCount(page, 1);
    } finally {
      await session.cleanup();
    }
  });

  test("rewinds the latest turn from the Command Center", async ({ page }) => {
    const firstPrompt = "Keep this earlier turn.";
    const latestPrompt = "Edit this latest turn.";
    const session = await seedMockAgentWorkspace({
      repoPrefix: "rewind-command-center-e2e-",
      title: "Command Center rewind",
      initialPrompt: firstPrompt,
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await submitMessage(page, latestPrompt);
      await expectUserMessageVisible(page, latestPrompt);
      await session.client.waitForFinish(session.agentId);

      const palette = await searchRewindActions(page);
      await expect(rewindAction(palette, "Rewind files")).toBeVisible();
      await expect(rewindAction(palette, "Rewind conversation and files")).toBeVisible();
      await rewindAction(palette, "Rewind conversation").click();

      await expectUserMessageVisible(page, firstPrompt);
      await expect(userMessage(page, latestPrompt)).toHaveCount(0);
      await expectComposerDraft(page, latestPrompt);
      await expectComposerFocused(page);
    } finally {
      await session.cleanup();
    }
  });

  test("waits for the latest prompt before offering Command Center rewind after reconnect", async ({
    page,
  }) => {
    const cachedPrompt = "Keep the prompt that was visible before reconnect.";
    const latestPrompt = "Rewind the prompt sent while the app was disconnected.";
    const gate = await installDaemonWebSocketGate(page);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "rewind-reconnect-e2e-",
      title: "Rewind after reconnect",
      initialPrompt: cachedPrompt,
    });

    try {
      await openAgentRoute(page, session);
      await expectUserMessageVisible(page, cachedPrompt);
      const initialPalette = await searchRewindActions(page);
      await expect(rewindAction(initialPalette, "Rewind conversation")).toBeVisible();
      await closeCommandCenter(page);

      await disconnectViewedTimeline(page, gate);
      await session.client.sendAgentMessage(session.agentId, latestPrompt);
      await session.client.waitForFinish(session.agentId);
      await restoreViewedTimelineHoldingCatchUp(page, gate);

      const palette = await searchRewindActions(page);
      await expect(palette.getByText("No matches", { exact: true })).toBeVisible();
      await releaseHeldCatchUp(page, gate);
      await rewindAction(palette, "Rewind conversation").click();

      await expectUserMessageVisible(page, cachedPrompt);
      await expectComposerDraft(page, latestPrompt);
    } finally {
      gate.restore();
      await session.cleanup();
    }
  });

  test("hides rewind when the latest prompt only contains an attachment", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "rewind-image-only-e2e-",
      title: "Rewind image-only prompt",
      initialPrompt: "Earlier text prompt.",
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      const palette = await searchRewindActions(page);
      await expect(rewindAction(palette, "Rewind conversation")).toBeVisible();
      await closeCommandCenter(page);

      await attachComposerTestImage(page);
      await submitMessageWithButton(page, "");
      const imagePrompt = page.getByTestId("user-message").filter({
        has: page.getByRole("button", { name: "Open image attachment" }),
      });
      await expect(imagePrompt).toHaveAttribute("aria-busy", "false");
      await session.client.waitForFinish(session.agentId);

      const reopened = await searchRewindActions(page);
      await expect(reopened.getByText("No matches", { exact: true })).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("surfaces rewind failures without crashing the page", async ({ page }) => {
    const firstPrompt = "emit 1 coalesced agent stream updates for failed rewind turn.";
    const rewindError = "No file checkpoint found for message rewind-failure-e2e.";
    const session = await seedMockAgentWorkspace({
      repoPrefix: "rewind-failure-e2e-",
      title: "Rewind failure e2e",
      initialPrompt: firstPrompt,
      featureValues: {
        mockRewindError: rewindError,
      },
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);

      await expectUserMessageVisible(page, firstPrompt);

      const palette = await searchRewindActions(page);
      await rewindAction(palette, "Rewind conversation").click();
      await expect(page.getByTestId("app-toast-message")).toHaveText(rewindError);

      await userMessage(page, firstPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      const rewindSheet = page.getByTestId("rewind-menu-content");
      await expect(rewindSheet).toBeVisible();
      await expect(
        rewindSheet.getByText("This action cannot be undone", { exact: true }),
      ).toBeVisible();
      await page.getByTestId("rewind-menu-conversation").click();

      await expect(page.getByTestId("app-toast-message")).toHaveText(rewindError);
      await expect(page.getByText("Uncaught Error")).toHaveCount(0);

      await userMessage(page, firstPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});
