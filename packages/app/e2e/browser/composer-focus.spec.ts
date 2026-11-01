import { expect, test, type Page } from "../support/fixtures";
import {
  blurComposerInput,
  switchComposerTabWithKeyboard,
  roundTripComposerTabBeforePaint,
  composerLocator,
  enterComposerFullscreen,
  exitComposerFullscreen,
  expectComposerDraft,
  expectComposerFocused,
  expectComposerFullscreenControls,
  expectComposerNotFocused,
  expectComposerVisible,
  expectWorkspaceHeaderVisible,
  resizeComposerViewport,
  submitMessage,
  typeIntoFocusedComposer,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { createMockIdleAgent, openWorkspaceWithAgents } from "../support/helpers/archive-tab";
import { seedWorkspace } from "../support/helpers/seed-client";
import { ensureExplorerSidebar } from "../support/helpers/workspace-tabs";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import {
  closeMobileAgentSidebar,
  closeMobileExplorer,
  expectMobileAgentSidebarHidden,
  expectMobileAgentSidebarVisible,
  expectMobileExplorerHidden,
  expectMobileExplorerVisible,
  swipeOpenMobileAgentSidebar,
  swipeOpenMobileExplorer,
} from "../support/helpers/sidebar";
import { readScrollMetrics } from "../support/helpers/agent-bottom-anchor";
import {
  expectTimelinePromptPositionPreserved,
  rememberTimelinePromptPosition,
  seedLongMockAgentTimeline,
  waitForTimelineGeometryToSettle,
} from "../support/helpers/timeline-pagination";

test("clicking chat text or background focuses the feed for keyboard paging", async ({
  page,
}, testInfo) => {
  const agent = await seedLongMockAgentTimeline({ turns: 8 });

  try {
    await openAgentRoute(page, agent);
    const composer = composerLocator(page);
    const feed = page.getByTestId("agent-chat-scroll").filter({ visible: true });
    await composer.fill("Keep this draft");
    await feed.getByText(agent.newestPrompt, { exact: true }).click();
    await expect(feed).toBeFocused();

    const beforePaging = await readScrollMetrics(page);
    expect(beforePaging.offsetY).toBeGreaterThan(beforePaging.viewportHeight);
    await page.keyboard.press("PageUp");
    await expect
      .poll(async () => (await readScrollMetrics(page)).offsetY)
      .toBeLessThan(beforePaging.offsetY - beforePaging.viewportHeight / 2);
    await page.screenshot({ path: testInfo.outputPath("chat-keyboard-paging.png") });
    await page.keyboard.press("PageDown");
    await expect
      .poll(async () => (await readScrollMetrics(page)).distanceFromBottom)
      .toBeLessThanOrEqual(2);

    await composer.click();
    await expectComposerFocused(page);
    await feed.click({ position: { x: 2, y: 40 } });
    await expect(feed).toBeFocused();
    await page.keyboard.press("PageUp");
    await expect
      .poll(async () => (await readScrollMetrics(page)).distanceFromBottom)
      .toBeGreaterThan(beforePaging.viewportHeight / 2);
    await waitForTimelineGeometryToSettle(page);
    const readingPrompt = agent.prompts[4];
    await expect(feed.getByText(readingPrompt, { exact: true })).toBeInViewport();
    const readingPosition = await rememberTimelinePromptPosition(page, readingPrompt);
    await agent.client.sendAgentMessage(agent.agentId, "emit 2 coalesced agent stream updates");
    await agent.client.waitForFinish(agent.agentId, 15_000);
    // The daemon finishing does not mean its response has reached the browser.
    await expect(feed.getByText(/stress-update-1/)).toHaveCount(1);
    await waitForTimelineGeometryToSettle(page);
    await expectTimelinePromptPositionPreserved(page, readingPosition);
    await expectComposerDraft(page, "Keep this draft");
  } finally {
    await agent.cleanup();
  }
});

test("focusing the feed preserves assistant text selection and code copy controls", async ({
  page,
  context,
}) => {
  const sentence = "Select this assistant sentence.";
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-focus-selection-",
    title: "Chat focus selection",
    initialPrompt: "Render text and code.",
    featureValues: {
      mockAssistantResponse: `${sentence}\n\n\`\`\`bash\necho example\n\`\`\``,
    },
  });

  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    await composerLocator(page).fill("Keep this draft");

    const feed = page.getByTestId("agent-chat-scroll").filter({ visible: true });
    await feed.getByText(sentence, { exact: true }).click({ clickCount: 3 });
    await expect(feed).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(sentence);
    await page.keyboard.press("ControlOrMeta+c");
    expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(sentence);

    const code = feed.locator('[data-paseo-markdown-language="bash"]');
    await code.hover();
    await code.locator("[data-paseo-markdown-ignore]").click();
    await expect(feed).not.toBeFocused();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("echo example");
    await expectComposerDraft(page, "Keep this draft");
  } finally {
    await agent.cleanup();
  }
});

test("submitting a message leaves the composer ready for the next message", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-",
    title: "Composer focus",
  });

  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);

    await submitMessage(page, "First message");
    await expectComposerFocused(page);

    await typeIntoFocusedComposer(page, "Second message");
    await expectComposerDraft(page, "Second message");
  } finally {
    await agent.cleanup();
  }
});

test("opening an agent focuses the composer when a mouse drives the UI", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-open-",
    title: "Composer focus on open",
  });

  try {
    await openAgentRoute(page, agent);
    await expectComposerFocused(page);
  } finally {
    await agent.cleanup();
  }
});

// Headless Chromium keeps every page focused and visible even after bringToFront.
// Supply browser lifecycle signals while keeping the app and daemon real.
async function setBrowserActive(
  page: Page,
  input: { active: boolean; signal: "visibility" | "focus" },
): Promise<void> {
  await page.evaluate(async ({ active, signal }) => {
    if (signal === "visibility") {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (active ? "visible" : "hidden"),
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => !active });
      document.dispatchEvent(new Event("visibilitychange"));
    } else {
      const previousFocus = document.activeElement;
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => active });
      window.dispatchEvent(new Event(active ? "focus" : "blur"));
      if (active && previousFocus && previousFocus !== document.body) {
        // Chromium restores element focus after the window focus event and its microtasks.
        await Promise.resolve();
        previousFocus.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      }
    }
  }, input);
  await waitForAnimationFrames(page, 4);
}

for (const signal of ["visibility", "focus"] as const) {
  test(`returning to the browser restores composer focus after ${signal} changes`, async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-browser-return-",
      title: "Composer browser return",
    });
    try {
      await openAgentRoute(page, agent);
      await composerLocator(page).fill("Keep this draft");
      const feed = page.getByTestId("agent-chat-scroll").filter({ visible: true });
      await feed.click({ position: { x: 2, y: 40 } });
      await expect(feed).toBeFocused();
      await setBrowserActive(page, { active: false, signal });
      await expectComposerNotFocused(page);
      await setBrowserActive(page, { active: true, signal });
      await expectComposerFocused(page);
      await typeIntoFocusedComposer(page, " after return");
      await expectComposerDraft(page, "Keep this draft after return");
    } finally {
      await agent.cleanup();
    }
  });
}

test("switching chat tabs focuses the selected composer and preserves each draft", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "composer-mouse-tabs-" });
  try {
    const first = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "First mouse chat",
    });
    const second = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Second mouse chat",
    });
    await openWorkspaceWithAgents(page, [first, second]);
    await expectComposerFocused(page);
    await composerLocator(page).fill("Second draft");
    await page.getByRole("button", { name: first.title, exact: true }).click();
    await expectComposerFocused(page);
    await composerLocator(page).fill("First draft");
    await page.keyboard.press("ControlOrMeta+f");
    const find = page.getByRole("textbox", { name: "Find in pane", exact: true });
    await find.fill("Search before switching chats");
    await switchComposerTabWithKeyboard(page, "next");
    await expectComposerFocused(page);
    await expectComposerDraft(page, "Second draft");
    await blurComposerInput(page);
    await setBrowserActive(page, { active: false, signal: "focus" });
    await setBrowserActive(page, { active: true, signal: "focus" });
    await expectComposerFocused(page);
    await typeIntoFocusedComposer(page, " after return");
    await expectComposerDraft(page, "Second draft after return");
    await switchComposerTabWithKeyboard(page, "previous");
    await expectComposerFocused(page);
    await expectComposerDraft(page, "First draft");
  } finally {
    await workspace.cleanup();
  }
});

test("browser return keeps the edited chat focused with another chat in Explorer", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "composer-explorer-focus-" });
  try {
    const first = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Main chat",
    });
    const second = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Explorer chat",
    });
    await openWorkspaceWithAgents(page, [first, second]);
    const explorer = await ensureExplorerSidebar(page);
    const tab = page.getByTestId(`workspace-tab-agent_${second.id}`).filter({ visible: true });
    const source = await tab.boundingBox();
    const target = await explorer.getByTestId("workspace-tabs-row").boundingBox();
    if (!source || !target) throw new Error("Missing chat or Explorer tab row");
    const startX = source.x + source.width / 2;
    const startY = source.y + source.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 12, startY + 4);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
      steps: 20,
    });
    await page.mouse.up();
    const mainInput = page
      .locator('[data-testid^="workspace-pane-"]')
      .getByRole("textbox", { name: "Message agent..." });
    const explorerInput = explorer.getByRole("textbox", { name: "Message agent..." });
    await expect(mainInput).toBeVisible();
    await expect(explorerInput).toBeVisible();
    for (const input of [mainInput, explorerInput]) {
      await input.fill("Keep editing this chat");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await setBrowserActive(page, { active: false, signal: "focus" });
        await setBrowserActive(page, { active: true, signal: "focus" });
        await expect(input).toBeFocused();
        await expect(input).toHaveValue("Keep editing this chat");
      }
    }
  } finally {
    await workspace.cleanup();
  }
});

test("returning to the browser preserves a rename dialog's input focus", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-dialog-",
    title: "Chat with a dialog",
  });
  try {
    await openAgentRoute(page, agent);
    await page
      .getByTestId(`workspace-tab-agent_${agent.agentId}`)
      .filter({ visible: true })
      .click({ button: "right" });
    await page.getByTestId(`workspace-tab-context-agent_${agent.agentId}-rename`).click();
    const input = page.getByTestId(`workspace-tab-rename-modal-agent-${agent.agentId}-input`);
    await input.fill("Keep editing this title");
    for (const signal of ["visibility", "focus"] as const) {
      await setBrowserActive(page, { active: false, signal });
      await setBrowserActive(page, { active: true, signal });
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Keep editing this title");
      await expectComposerNotFocused(page);
    }
  } finally {
    await agent.cleanup();
  }
});

test("returning to the browser preserves chat Find input focus", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-find-",
    title: "Chat with Find",
  });
  try {
    await openAgentRoute(page, agent);
    await expectComposerFocused(page);
    await page.keyboard.press("ControlOrMeta+f");
    const input = page.getByRole("textbox", { name: "Find in pane", exact: true });
    await input.fill("Keep this search");
    for (const signal of ["visibility", "focus"] as const) {
      await setBrowserActive(page, { active: false, signal });
      await setBrowserActive(page, { active: true, signal });
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Keep this search");
      await expectComposerNotFocused(page);
    }
  } finally {
    await agent.cleanup();
  }
});

test("browser activation preserves an input focused before its deferred autofocus", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-deferred-",
    title: "Deferred browser focus",
  });
  try {
    await openAgentRoute(page, agent);
    await expectComposerFocused(page);
    await page.keyboard.press("ControlOrMeta+f");
    const find = page.getByRole("textbox", { name: "Find in pane", exact: true });
    await find.fill("Keep this search");
    await composerLocator(page).click();
    await blurComposerInput(page);
    await setBrowserActive(page, { active: false, signal: "focus" });
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
      window.dispatchEvent(new Event("focus"));
    });
    await find.focus();
    await page.clock.runFor(100);
    await expect(find).toBeFocused();
    await expect(find).toHaveValue("Keep this search");
    await expectComposerNotFocused(page);
  } finally {
    await page.clock.resume();
    await agent.cleanup();
  }
});

test("an activation click before the focus effect preserves its button target", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-early-pointer-",
    title: "Activation click before effects",
  });
  try {
    await openAgentRoute(page, agent);
    await composerLocator(page).fill("Keep this draft");
    await setBrowserActive(page, { active: false, signal: "focus" });
    const button = page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).first();
    await button.evaluate((element) => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
      window.dispatchEvent(new Event("focus"));
      // A native activation click can finish before React commits its passive effects.
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      if (!(element instanceof HTMLElement)) throw new Error("Explorer toggle is not an element");
      element.focus();
    });
    await waitForAnimationFrames(page, 4);
    await expect(button).toBeFocused();
    await expectComposerNotFocused(page);
    await expectComposerDraft(page, "Keep this draft");
  } finally {
    await agent.cleanup();
  }
});

test("an activation click in an unfocused split pane keeps its feed focused", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "composer-split-activation-" });
  try {
    const first = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Left activation chat",
    });
    const second = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Right activation chat",
    });
    await openWorkspaceWithAgents(page, [first, second]);
    await runWorkspaceActionFromCommandCenter(page, "Split pane right");
    const tab = page.getByTestId(`workspace-tab-agent_${second.id}`).filter({ visible: true });
    const source = await tab.boundingBox();
    const target = await page.getByTestId("workspace-new-tab-panel").boundingBox();
    if (!source || !target) throw new Error("Missing chat tab or new split pane");
    const startX = source.x + source.width / 2;
    const startY = source.y + source.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 12, startY + 4);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
      steps: 20,
    });
    await page.mouse.up();
    const leftPane = page
      .locator('[data-testid^="workspace-pane-"]')
      .filter({ has: page.getByTestId(`workspace-tab-agent_${first.id}`) });
    const rightPane = page
      .locator('[data-testid^="workspace-pane-"]')
      .filter({ has: page.getByTestId(`workspace-tab-agent_${second.id}`) });
    const leftInput = leftPane.getByRole("textbox", { name: "Message agent..." });
    const rightInput = rightPane.getByRole("textbox", { name: "Message agent..." });
    const feed = rightPane.getByTestId("agent-chat-scroll");
    await expect(rightInput).toBeVisible();
    await leftInput.fill("Keep this left draft");
    await setBrowserActive(page, { active: false, signal: "focus" });
    await feed.evaluate((element) => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
      window.dispatchEvent(new Event("focus"));
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      if (!(element instanceof HTMLElement)) throw new Error("Chat feed is not an element");
      element.focus();
    });
    await waitForAnimationFrames(page, 4);
    await expect(feed).toBeFocused();
    await expect(rightInput).not.toBeFocused();
    await expect(leftInput).toHaveValue("Keep this left draft");
  } finally {
    await workspace.cleanup();
  }
});

test("returning to the browser preserves selected chat text", async ({ page }) => {
  const sentence = "Keep this selected assistant sentence.";
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-selection-return-",
    title: "Browser return with selected text",
    initialPrompt: "Render a sentence.",
    featureValues: { mockAssistantResponse: sentence },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    const feed = page.getByTestId("agent-chat-scroll").filter({ visible: true });
    await feed.getByText(sentence, { exact: true }).click({ clickCount: 3 });
    await expect(feed).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(sentence);
    await setBrowserActive(page, { active: false, signal: "focus" });
    await setBrowserActive(page, { active: true, signal: "focus" });
    await expect(feed).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(sentence);
    await expectComposerNotFocused(page);
  } finally {
    await agent.cleanup();
  }
});

async function waitForAnimationFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

test.describe("touch screen wide enough for the desktop layout", () => {
  // A tablet or an unfolded foldable gets the desktop layout, but focusing the
  // composer there raises the on-screen keyboard over the conversation.
  test.use({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true });

  test("returning to the browser leaves a touch composer unfocused", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-touch-browser-return-",
      title: "Touch browser return",
    });
    try {
      await openAgentRoute(page, agent);
      await composerLocator(page).fill("Keep this touch draft");
      await blurComposerInput(page);
      for (const signal of ["visibility", "focus"] as const) {
        await setBrowserActive(page, { active: false, signal });
        await setBrowserActive(page, { active: true, signal });
        await expectComposerNotFocused(page);
        await expectComposerDraft(page, "Keep this touch draft");
      }
    } finally {
      await agent.cleanup();
    }
  });

  test("remounting an inline composer does not restore focus on touch", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-touch-remount-",
      title: "Touch remount",
    });
    try {
      await openAgentRoute(page, agent);
      await composerLocator(page).fill("Keep this draft through resize");
      await expectComposerFocused(page);
      await resizeComposerViewport(page, "portrait");
      await expectComposerDraft(page, "Keep this draft through resize");
      await expectComposerNotFocused(page);
      await composerLocator(page).tap();
      await expectComposerFocused(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("returning to an inactive inline composer does not restore focus on touch", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-touch-retained-" });
    try {
      const first = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "First touch chat",
      });
      const second = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Second touch chat",
      });
      await openWorkspaceWithAgents(page, [first, second]);
      // Repeat after an explicit edit so retained focus from an earlier visit is
      // also dismissed when the same mounted editor becomes inactive again.
      for (const draft of ["Keep this touch draft", "Edit this touch draft again"]) {
        await composerLocator(page).fill(draft);
        await expectComposerFocused(page);
        // An external keyboard changes tabs without a pointer click blurring the
        // editor first. The device still has a touch-primary focus policy.
        await roundTripComposerTabBeforePaint(page, "Second touch chat");
        await expectComposerDraft(page, draft);
        await expectComposerNotFocused(page);
        await composerLocator(page).tap();
        await expectComposerFocused(page);
        await typeIntoFocusedComposer(page, " after return");
        await expectComposerDraft(page, `${draft} after return`);
      }
    } finally {
      await workspace.cleanup();
    }
  });

  test("opening an agent leaves the composer unfocused", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-focus-touch-",
      title: "Composer focus on touch",
    });

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      expect(
        await page.evaluate(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches),
      ).toBe(false);
      // Autofocus makes its first attempt on the next animation frame.
      await waitForAnimationFrames(page, 4);
      await expectComposerNotFocused(page);
    } finally {
      await agent.cleanup();
    }
  });
});

const COMPACT_PANELS = [
  {
    name: "agent list",
    open: swipeOpenMobileAgentSidebar,
    expectOpen: expectMobileAgentSidebarVisible,
    close: closeMobileAgentSidebar,
    expectClosed: expectMobileAgentSidebarHidden,
  },
  {
    name: "Explorer",
    open: swipeOpenMobileExplorer,
    expectOpen: expectMobileExplorerVisible,
    close: closeMobileExplorer,
    expectClosed: expectMobileExplorerHidden,
  },
] as const;

for (const panel of COMPACT_PANELS) {
  test(`closing the compact ${panel.name} does not restore composer focus`, async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-focus-panel-",
      title: `Composer focus under ${panel.name}`,
    });
    const draft = "Line one\nLine two\nLine three";
    try {
      await resizeComposerViewport(page, "portrait");
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      await test.step("an untouched editor stays untouched", async () => {
        await expectComposerNotFocused(page);
        await panel.open(page);
        await panel.expectOpen(page);
        await panel.close(page);
        await panel.expectClosed(page);
        await expectComposerNotFocused(page);
      });

      await test.step("an inline editor blurred under the panel stays blurred", async () => {
        await composerLocator(page).fill(draft);
        await composerLocator(page).click();
        await expectComposerFocused(page);
        await panel.open(page);
        await panel.expectOpen(page);
        await blurComposerInput(page);
        await panel.close(page);
        await panel.expectClosed(page);
        await expectComposerNotFocused(page);
        await expectComposerDraft(page, draft);
      });

      await test.step("a fullscreen editor blurred under the panel stays blurred", async () => {
        await composerLocator(page).click();
        await enterComposerFullscreen(page);
        await expectComposerFullscreenControls(page);
        await expectComposerFocused(page);
        await panel.open(page);
        await panel.expectOpen(page);
        await blurComposerInput(page);
        await panel.close(page);
        await panel.expectClosed(page);
        await expectComposerNotFocused(page);
        await expectComposerFullscreenControls(page);
        await expectComposerDraft(page, draft);
        await exitComposerFullscreen(page);
        await expectWorkspaceHeaderVisible(page);
      });
    } finally {
      await agent.cleanup();
    }
  });
}
