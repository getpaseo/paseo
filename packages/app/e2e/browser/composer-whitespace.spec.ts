import { createMockIdleAgent, openWorkspaceWithAgents } from "../support/helpers/archive-tab";
import { seedWorkspace } from "../support/helpers/seed-client";
import { expect, test, type Page } from "../support/fixtures";
import {
  expectNearBottom,
  scrollAgentChatToBottom,
  waitForScrollableChat,
} from "../support/helpers/agent-bottom-anchor";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import {
  attachComposerTestImage,
  pasteComposerTestImage,
  enterComposerFullscreen,
  exitComposerFullscreen,
  resizeComposerViewport,
  selectComposerDraftRange,
  expectComposerDraftSelection,
  expectComposerFullscreenControls,
  sendComposerWithButton,
  queueComposerWithButton,
  configureComposerQueueSend,
  activateRetainedComposerTab,
  recordVisibleComposerGeometry,
  expectNoCollapsedVisibleComposer,
  expectAttachmentPill,
  expectQueuedMessageButton,
  startRunningMockAgent,
  composerLocator,
  expectComposerVisible,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

async function composerHeight(page: Page): Promise<number> {
  return composerLocator(page).evaluate((element) => element.getBoundingClientRect().height);
}

async function expectComposerHeight(page: Page, expected: number): Promise<void> {
  await expect.poll(() => composerHeight(page)).toBe(expected);
}

async function pressComposerKeyAndMeasureNextPaint(page: Page, key: string): Promise<number> {
  const composer = composerLocator(page);
  await installNextComposerPaintProbe(page);
  await composer.press(key);
  return readNextComposerPaintHeight(page);
}

async function typeComposerTextAndMeasureNextPaint(page: Page, text: string): Promise<number> {
  const composer = composerLocator(page);
  await installNextComposerPaintProbe(page);
  await composer.pressSequentially(text);
  return readNextComposerPaintHeight(page);
}

async function installNextComposerPaintProbe(page: Page): Promise<void> {
  await composerLocator(page).evaluate((element) => {
    Reflect.set(
      globalThis,
      "__composerNextPaintHeight",
      new Promise<number>((resolve) => {
        element.addEventListener(
          "input",
          () => {
            requestAnimationFrame(() => resolve(element.getBoundingClientRect().height));
          },
          { once: true },
        );
      }),
    );
  });
}

async function readNextComposerPaintHeight(page: Page): Promise<number> {
  return page.evaluate(() => Reflect.get(globalThis, "__composerNextPaintHeight"));
}

test("blank composer lines remain present and keep their measured height", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-whitespace-",
    title: "Composer whitespace",
  });

  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    const composer = composerLocator(page);
    const blankLines = "\n\n\n\n\n";
    const collapsedHeight = await composerHeight(page);

    await test.step("remeasure the current draft when the window narrows", async () => {
      await page.setViewportSize({ width: 1280, height: 1200 });
      const text = "A sentence that wraps when the editor becomes narrower. ".repeat(8);
      await composer.fill(text);
      await expect(composer).toHaveValue(text);
      await expect.poll(() => composerHeight(page)).toBeGreaterThan(collapsedHeight);
      const wideHeight = await composerHeight(page);
      await page.setViewportSize({ width: 480, height: 1200 });
      await expect.poll(() => composerHeight(page)).toBeGreaterThan(wideHeight);
      await expect(composer).toHaveValue(text);
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    await test.step("grow the composer with blank lines followed by text", async () => {
      await composer.fill(`${blankLines}x`);
      await expect(composer).toHaveValue(`${blankLines}x`);
      await expect.poll(() => composerHeight(page)).toBeGreaterThan(collapsedHeight);
    });

    await test.step("delete only the text without losing the blank lines or height", async () => {
      const expandedHeight = await composerHeight(page);
      await composer.press("Backspace");
      await expect(composer).toHaveValue(blankLines);
      await expectComposerHeight(page, expandedHeight);
    });

    await test.step("grow on the first paint of a newline and stay stable when it receives a glyph", async () => {
      await composer.fill("alpha\nbeta");
      const filledLineHeight = await composerHeight(page);
      const trailingLineHeight = await pressComposerKeyAndMeasureNextPaint(page, "Shift+Enter");
      expect(trailingLineHeight).toBeGreaterThan(filledLineHeight);

      const filledTrailingLineHeight = await typeComposerTextAndMeasureNextPaint(page, "x");
      await expect(composer).toHaveValue("alpha\nbeta\nx");
      expect(filledTrailingLineHeight).toBe(trailingLineHeight);
    });
  } finally {
    await agent.cleanup();
  }
});

test("composer growth keeps a bottom-pinned chat at the bottom", async ({ page }) => {
  test.setTimeout(90_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-bottom-anchor-",
    title: "Composer bottom anchor",
    initialPrompt: "Produce enough content to make the chat scrollable.",
    model: "ten-second-stream",
  });

  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await waitForScrollableChat(page, { minScrollableDistance: 200, timeout: 30_000 });
    await scrollAgentChatToBottom(page);

    const composer = composerLocator(page);
    await composer.fill("alpha");
    for (let line = 0; line < 8; line += 1) {
      await composer.press("Shift+Enter");
    }

    await expectNearBottom(page);
  } finally {
    await agent.cleanup();
  }
});

async function writeCompactDraft(page: Page, text: string): Promise<void> {
  await composerLocator(page).fill(text);
  await expect(composerLocator(page)).toHaveValue(text);
}

test("compact long drafts stop growing before the header", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-cap-",
    title: "Composer cap",
  });
  try {
    await resizeComposerViewport(page, "portrait");
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await writeCompactDraft(page, "A long draft line\n".repeat(40));
    await expect.poll(() => composerHeight(page)).toBeLessThanOrEqual(160);
  } finally {
    await agent.cleanup();
  }
});

test("compact fullscreen editing preserves the live draft and selection and stays open after send", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-fullscreen-",
    title: "Fullscreen composer",
  });
  try {
    await resizeComposerViewport(page, "portrait");
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await attachComposerTestImage(page);
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await writeCompactDraft(page, "First line\nSecond line");
    await expect(page.getByRole("button", { name: "Fullscreen", exact: true })).toHaveCount(0);
    await writeCompactDraft(page, "First line\nSecond line\nThird line");
    await expect(page.getByRole("button", { name: "Fullscreen", exact: true })).toBeVisible();
    await writeCompactDraft(
      page,
      "A sentence with enough words to wrap across several rendered lines in a narrow input. ".repeat(
        4,
      ),
    );
    await expect(page.getByRole("button", { name: "Fullscreen", exact: true })).toBeVisible();
    await selectComposerDraftRange(page, 4, 17);
    await enterComposerFullscreen(page);
    await expectComposerFullscreenControls(page);
    await expectComposerDraftSelection(page, 4, 17);
    await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0);
    await writeCompactDraft(page, "Edited fullscreen draft\nSecond line\nThird line");
    await selectComposerDraftRange(page, 3, 12);
    await exitComposerFullscreen(page);
    await expect(composerLocator(page)).toHaveValue(
      "Edited fullscreen draft\nSecond line\nThird line",
    );
    await expectComposerDraftSelection(page, 3, 12);
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await expect(composerLocator(page)).toBeFocused();
    await enterComposerFullscreen(page);
    await writeCompactDraft(page, "Short draft");
    await expectComposerFullscreenControls(page);
    await selectComposerDraftRange(page, 0, 5);
    await resizeComposerViewport(page, "landscape");
    await expectComposerFullscreenControls(page);
    await expectComposerDraftSelection(page, 0, 5);
    await expect(composerLocator(page)).toHaveValue("Short draft");
    await expect(composerLocator(page)).toBeFocused();
    await resizeComposerViewport(page, "portrait");
    await sendComposerWithButton(page);
    await expect(composerLocator(page)).toHaveValue("");
    await expectComposerFullscreenControls(page);
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  } finally {
    await agent.cleanup();
  }
});

test("fullscreen submit rejection retains the editable draft and supports retry", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-fullscreen-retry-",
    title: "Fullscreen retry",
    featureValues: { mockPromptRejections: 1 },
  });
  const draft = "First line\nSecond line\nThird line";
  try {
    await resizeComposerViewport(page, "portrait");
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await writeCompactDraft(page, draft);
    await enterComposerFullscreen(page);
    await sendComposerWithButton(page);
    await expect(page.getByTestId("composer-fullscreen").getByRole("alert")).toHaveText(
      "Requested mock prompt rejection",
    );
    await expect(composerLocator(page)).toHaveValue(draft);
    await expect(composerLocator(page)).toBeEditable();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await sendComposerWithButton(page);
    await expect(composerLocator(page)).toHaveValue("");
    await expectComposerFullscreenControls(page);
  } finally {
    await agent.cleanup();
  }
});

test("fullscreen Send keeps the configured queue behavior while an agent runs", async ({
  page,
}) => {
  await configureComposerQueueSend(page);
  await resizeComposerViewport(page, "portrait");
  const agent = await startRunningMockAgent(page, {
    prefix: "composer-fullscreen-queue-",
    model: "one-minute-stream",
    prompt: "Stay running for fullscreen queue test.",
  });
  try {
    await writeCompactDraft(page, "Queued first line\nSecond line\nThird line");
    await enterComposerFullscreen(page);
    await expectComposerFullscreenControls(page);
    await queueComposerWithButton(page);
    await expect(composerLocator(page)).toHaveValue("");
    await expectComposerFullscreenControls(page);
    await exitComposerFullscreen(page);
    await expectQueuedMessageButton(page);
  } finally {
    await agent.cleanup();
  }
});

test("image paste stays attached to the active editor across fullscreen entry and exit", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-paste-remount-",
    title: "Composer paste",
  });
  try {
    await resizeComposerViewport(page, "portrait");
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await writeCompactDraft(page, "First line\nSecond line\nThird line");
    expect(await pasteComposerTestImage(page)).toBe(true);
    await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(1);
    await enterComposerFullscreen(page);
    expect(await pasteComposerTestImage(page)).toBe(true);
    await exitComposerFullscreen(page);
    await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(2);
    expect(await pasteComposerTestImage(page)).toBe(true);
    await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(3);
  } finally {
    await agent.cleanup();
  }
});

test("retained agent tabs preserve fullscreen editing and paste when switched away and back", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "composer-retained-fullscreen-" });
  try {
    const first = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "First retained chat",
    });
    const second = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Second retained chat",
    });
    await openWorkspaceWithAgents(page, [first, second]);
    await resizeComposerViewport(page, "portrait");
    const draft = "Live first line\nLive second line\nLive third line";
    await writeCompactDraft(page, draft);
    await enterComposerFullscreen(page);
    await selectComposerDraftRange(page, 4, 17);
    await activateRetainedComposerTab(page, first.title);
    await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toHaveCount(0);
    await writeCompactDraft(page, "Other tab draft");
    await activateRetainedComposerTab(page, second.title);
    await expectComposerFullscreenControls(page);
    await expect(composerLocator(page)).toHaveValue(draft);
    await expectComposerDraftSelection(page, 4, 17);
    await expect(composerLocator(page)).toBeFocused();
    expect(await pasteComposerTestImage(page)).toBe(true);
    await exitComposerFullscreen(page);
    await expectAttachmentPill(page, "composer-image-attachment-pill");
  } finally {
    await workspace.cleanup();
  }
});

test("retained inline composers keep usable capacity through hidden tab geometry", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "composer-retained-capacity-" });
  try {
    const first = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "First capacity chat",
    });
    const second = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Second capacity chat",
    });
    await openWorkspaceWithAgents(page, [first, second]);
    await resizeComposerViewport(page, "portrait");
    const draft = "Retained long line\n".repeat(40);
    await writeCompactDraft(page, draft);
    await recordVisibleComposerGeometry(page);
    await activateRetainedComposerTab(page, first.title);
    await writeCompactDraft(page, "Other visible draft");
    await activateRetainedComposerTab(page, second.title);
    await expect(composerLocator(page)).toHaveValue(draft);
    await expect.poll(() => composerHeight(page)).toBeLessThanOrEqual(160);
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await expectNoCollapsedVisibleComposer(page);
  } finally {
    await workspace.cleanup();
  }
});
