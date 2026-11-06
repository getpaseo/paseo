import { test, expect } from "../support/fixtures";
import { openWorkspaceWithAgents } from "../support/helpers/archive-tab";
import { fillComposerDraft } from "../support/helpers/composer";
import {
  expectComposerToolbarOnTextRails,
  expectNoCollapsedComposerToolbarFrame,
  expectNoFrameTruncatesModelBesideThinking,
  readSettledModelTriggerLabels,
  recordComposerToolbarFrames,
  recordModelTriggerFramesFromLoad,
  sweepModelTriggerLabels,
} from "../support/helpers/composer-control-density";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const SETTLE_MS = 1_000;

async function seedSettledMockAgent(workspace: SeededWorkspace, title: string) {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title,
  });
  await workspace.client.waitForAgentUpsert(
    agent.id,
    (snapshot) => snapshot.status === "idle",
    30_000,
  );
  return { id: agent.id, title, cwd: workspace.repoPath, workspaceId: workspace.workspaceId };
}

function visibleAgentTab(page: import("@playwright/test").Page, agentId: string) {
  return page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first();
}

test.describe("Composer control density across tab switches", () => {
  test.describe.configure({ timeout: 180_000 });

  test("switching between agent tabs never paints a collapsed composer toolbar", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-density-agents-" });
    try {
      const first = await seedSettledMockAgent(workspace, "First chat");
      const second = await seedSettledMockAgent(workspace, "Second chat");
      await openWorkspaceWithAgents(page, [first, second]);

      await recordComposerToolbarFrames(page);
      await visibleAgentTab(page, first.id).click();
      await page.waitForTimeout(SETTLE_MS);
      await visibleAgentTab(page, second.id).click();
      await page.waitForTimeout(SETTLE_MS);

      await expectNoCollapsedComposerToolbarFrame(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("switching between draft tabs never paints a collapsed composer toolbar", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-density-drafts-" });
    try {
      await page.addInitScript(() => {
        localStorage.setItem(
          "@paseo:create-agent-preferences",
          JSON.stringify({
            provider: "mock",
            providerPreferences: { mock: { mode: "load-test" } },
          }),
        );
      });
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewChat(page);
      await clickNewChat(page);

      const draftTabs = page
        .locator('[data-testid^="workspace-tab-draft"]')
        .filter({ visible: true });
      await expect(draftTabs).toHaveCount(2, { timeout: 30_000 });
      await expect(
        page.locator('[data-testid="mode-control"]').filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 30_000 });

      await recordComposerToolbarFrames(page);
      await draftTabs.nth(0).click();
      await page.waitForTimeout(SETTLE_MS);
      await draftTabs.nth(1).click();
      await page.waitForTimeout(SETTLE_MS);

      await expectNoCollapsedComposerToolbarFrame(page);
    } finally {
      await workspace.cleanup();
    }
  });
});

test.describe("Composer controls folding on a touch device", () => {
  test.use({ viewport: { width: 1194, height: 834 }, isMobile: true, hasTouch: true });
  test.describe.configure({ timeout: 180_000 });

  test("an open menu stays closed after the controls fold and unfold", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "composer-density-fold-",
      title: "Folding chat",
      model: "ten-second-stream",
    });
    try {
      await openAgentRoute(page, session);
      const thinking = page.getByTestId("agent-thinking-selector").filter({ visible: true });
      const thinkingMenu = page.getByTestId("combobox-desktop-container");

      await thinking.click();
      await expect(thinkingMenu).toBeVisible();

      // Still a wide layout, but too narrow for separate controls: they fold into the model control.
      await page.setViewportSize({ width: 640, height: 834 });
      await expect(thinking).toHaveCount(0);

      await page.setViewportSize({ width: 1194, height: 834 });
      await expect(thinking).toBeVisible();
      await expect(thinkingMenu).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });
});

test.describe("Folded model control on a phone", () => {
  // Wide enough for "Ten second stream" and "Low" side by side; narrower, they no longer fit.
  test.use({ viewport: { width: 480, height: 844 }, isMobile: true, hasTouch: true });
  test.describe.configure({ timeout: 180_000 });

  test("hides the thinking label before the model label truncates", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "composer-density-labels-",
      title: "Label priority chat",
      model: "ten-second-stream",
    });
    try {
      await recordModelTriggerFramesFromLoad(page);
      await openAgentRoute(page, session);
      await expect(
        page.getByTestId("combined-model-selector-thinking-label").filter({ visible: true }),
      ).toHaveText("Low");
      await readSettledModelTriggerLabels(page);
      // From the first frame on, the control never guesses: it paints both labels only once it
      // has measured that they fit.
      await expectNoFrameTruncatesModelBesideThinking(page);

      const sweep = await sweepModelTriggerLabels(page, {
        from: 480,
        to: 280,
        step: 4,
        height: 844,
      });

      expect(sweep.widest).toMatchObject({
        modelText: "Ten second stream",
        thinkingShown: true,
        modelTruncated: false,
      });
      expect(sweep.thinkingHidden).toMatchObject({
        modelText: "Ten second stream",
        modelTruncated: false,
      });
      expect(sweep.modelTruncated.width).toBeLessThan(sweep.thinkingHidden.width);
      // A clean tail: the label ends on a whole word and the ellipsis, never on a space.
      expect(sweep.modelTruncated).toMatchObject({
        modelText: "Ten second…",
        thinkingShown: false,
      });
    } finally {
      await session.cleanup();
    }
  });
});

test.describe("Composer toolbar rails on touch", () => {
  test.use({ isMobile: true, hasTouch: true });
  test.describe.configure({ timeout: 180_000 });

  for (const viewport of [
    { device: "phone", width: 390, height: 844 },
    { device: "tablet", width: 1024, height: 1366 },
  ]) {
    test(`the toolbar starts on the text rail and ends in a disc nested in the corner on a ${viewport.device}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const idle = await seedMockAgentWorkspace({
        repoPrefix: "composer-rails-idle-",
        title: "Rails idle chat",
      });
      let running: Awaited<ReturnType<typeof seedMockAgentWorkspace>> | null = null;
      try {
        await openAgentRoute(page, idle);
        await expect(page.getByTestId("message-input-root").filter({ visible: true })).toBeVisible({
          timeout: 30_000,
        });
        await test.step("empty composer: attach on the left, voice mode on the right", async () => {
          await expectComposerToolbarOnTextRails(page);
        });
        await test.step("draft: the send disc on the right", async () => {
          await fillComposerDraft(page, "Refactor the composer toolbar");
          await expect(page.getByRole("button", { name: /send/i }).first()).toBeVisible();
          await expectComposerToolbarOnTextRails(page);
        });

        running = await seedMockAgentWorkspace({
          repoPrefix: "composer-rails-running-",
          title: "Rails running chat",
          model: "one-minute-stream",
          initialPrompt: "stream for a while",
        });
        await openAgentRoute(page, running);
        await test.step("running agent: the stop disc on the right", async () => {
          await expect(page.getByRole("button", { name: /stop agent/i }).first()).toBeVisible({
            timeout: 30_000,
          });
          await expectComposerToolbarOnTextRails(page);
        });
      } finally {
        await idle.cleanup();
        await running?.cleanup();
      }
    });
  }
});

test.describe("Composer trailing disc on a new chat", () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 1024, height: 1366 } });

  test("an empty draft holds a disabled send disc until there is something to send", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-placeholder-send-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewChat(page);
      const send = page
        .getByTestId("message-input-root")
        .filter({ visible: true })
        .getByRole("button", { name: "Send message", exact: true });
      await expect(send).toBeDisabled({ timeout: 30_000 });
      await fillComposerDraft(page, "Refactor the composer toolbar");
      await expect(send).toBeEnabled();
    } finally {
      await workspace.cleanup();
    }
  });
});
