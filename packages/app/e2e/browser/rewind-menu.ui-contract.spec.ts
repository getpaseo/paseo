import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { scrollChatAwayFromBottom } from "../support/helpers/agent-bottom-anchor";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
  submitMessage,
} from "../support/helpers/composer";
import { readReplicaCache, writeReplicaCache } from "../support/helpers/replica-cache-storage";

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

async function rewriteCachedMessageAsLegacyRow(page: Page, prompt: string): Promise<void> {
  await expect
    .poll(async () => {
      const cache = await readReplicaCache(page);
      if (!cache) return false;
      for (const host of cache.hosts ?? []) {
        for (const item of host.timeline?.items ?? []) {
          if (item.kind === "user_message" && item.text === prompt && item.messageId) {
            return true;
          }
        }
      }
      return false;
    })
    .toBe(true);

  const cache = await readReplicaCache(page);
  if (!cache) throw new Error("Replica cache was not persisted");
  const cachedMessage = cache.hosts
    ?.flatMap((host) => host.timeline?.items ?? [])
    .find((item) => item.kind === "user_message" && item.text === prompt);
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
        ?.flatMap((host) => host.timeline?.items ?? [])
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
        ?.flatMap((host) => host.timeline?.items ?? [])
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
    let heldTimelineRequest = false;

    try {
      await openAgentRoute(page, session);
      await expectUserMessageVisible(page, prompt);
      await rewriteCachedMessageAsLegacyRow(page, prompt);
      gate.holdNextClientRequest("fetch_agent_timeline_request");
      await page.reload();
      await gate.waitForHeldClientRequest();
      heldTimelineRequest = true;

      const restoredMessage = userMessage(page, prompt);
      await expect(restoredMessage).toBeVisible();
      await restoredMessage.hover();
      await expect(restoredMessage.getByTestId("rewind-menu-trigger")).toHaveCount(0);
      await waitForCachedMessageWithoutProviderId(page, prompt);
    } finally {
      if (heldTimelineRequest) gate.releaseHeldClientRequest();
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

      await scrollChatAwayFromBottom(page, {
        deltaY: -900,
        minDistanceFromBottom: 300,
      });
      await userMessage(page, firstPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      const rewindSheet = page.getByTestId("rewind-menu-content");
      await expect(rewindSheet).toBeVisible();
      await expect(
        rewindSheet.getByText("This action cannot be undone", { exact: true }),
      ).toBeVisible();
      await page.getByTestId("rewind-menu-conversation").click();

      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expect(userMessage(page, secondPrompt)).toHaveCount(0);
      await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
      await expectUserMessageCount(page, 1);
      await expectComposerDraft(page, firstPrompt);

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
      await page.getByTestId("rewind-menu-files").click();
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, "");
      await expectUserMessageCount(page, 2);

      const preservedDraft = "Keep this human draft after rewind.";
      await fillComposerDraft(page, preservedDraft);
      await composerLocator(page).evaluate((element) => element.blur());
      await userMessage(page, replacementPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await page.getByTestId("rewind-menu-files").click();
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, preservedDraft);
      await expectUserMessageCount(page, 2);

      await fillComposerDraft(page, "");
      await composerLocator(page).evaluate((element) => element.blur());
      await userMessage(page, replacementPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await page.getByTestId("rewind-menu-both").click();
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, replacementPrompt);
      await expectUserMessageCount(page, 1);
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
