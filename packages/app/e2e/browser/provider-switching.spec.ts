import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { expectAgentIdle, expectAgentReadyToInterrupt } from "../support/helpers/agent-stream";
import {
  drillIntoProvider,
  expectComposerMode,
  expectComposerModel,
  openModelPicker,
  selectModelRow,
} from "../support/helpers/agent-profiles";
import { expectWorkspaceAgentConfiguration } from "../support/helpers/command-center-agent-controls";
import {
  expectComposerVisible,
  expectQueuedMessageButton,
  submitMessage,
  submitMessageWithButton,
} from "../support/helpers/composer";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { userScrollsTimelineToHistoryStart } from "../support/helpers/timeline-pagination";

const DIRECT_PROVIDER = {
  id: "direct-example",
  label: "Direct provider example",
  pluginId: "provider-direct-example",
  modelId: "example-1",
  modelLabel: "Example 1",
  modeLabel: "Build",
} as const;

// Disable external CLIs so the E2E host deterministically exposes only Mock +
// the installed Direct provider plugin on both developer machines and CI.
test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
        antigravity: { enabled: false },
        hoplite: { enabled: false },
      },
    },
  },
});

interface PluginInstallDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  getDaemonConfig(): Promise<{ config: { pluginsEnabled?: boolean } }>;
  patchDaemonConfig(config: { pluginsEnabled?: boolean }): Promise<unknown>;
  installDirectoryPlugin(directory: string): Promise<unknown>;
  removePlugin(pluginId: string): Promise<void>;
  getProvidersSnapshot(): Promise<{
    entries: Array<{ provider: string; available?: boolean }>;
  }>;
}

async function hasDirectProvider(client: PluginInstallDaemonClient): Promise<boolean> {
  const snapshot = await client.getProvidersSnapshot();
  return snapshot.entries.some((entry) => entry.provider === DIRECT_PROVIDER.id);
}

async function expectSwitchMarkerCountAfterScroll(page: Page, expected: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await userScrollsTimelineToHistoryStart(page);
        return await page.getByTestId("provider-switch-marker").count();
      },
      { timeout: 30_000 },
    )
    .toBe(expected);
}

async function captureQaScreenshot(page: Page, fileName: string): Promise<void> {
  const dir = process.env.PASEO_QA_SCREENSHOT_DIR?.trim();
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, fileName), fullPage: false });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return Math.ceil(doc.scrollWidth - doc.clientWidth);
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

async function completeMockTurn(
  page: Page,
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
  prompt: string,
): Promise<Locator> {
  await submitMessage(page, prompt);
  const userMessage = page.getByTestId("user-message").filter({ hasText: prompt });
  await expect(userMessage).toBeVisible({ timeout: 30_000 });
  const finish = await agent.client.waitForFinish(agent.agentId, 30_000);
  expect(finish.status).toBe("idle");
  await expectAgentIdle(page);
  await expect(userMessage).toHaveAttribute("aria-busy", "false");
  return userMessage;
}

async function completeDirectTurn(
  page: Page,
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
  prompt: string,
  options?: { useSendButton?: boolean },
): Promise<Locator> {
  if (options?.useSendButton) {
    await submitMessageWithButton(page, prompt);
  } else {
    await submitMessage(page, prompt);
  }
  const userMessage = page.getByTestId("user-message").filter({ hasText: prompt });
  await expect(userMessage).toBeVisible({ timeout: 30_000 });
  const finish = await agent.client.waitForFinish(agent.agentId, 30_000);
  expect(finish.status).toBe("idle");
  await expectAgentIdle(page);
  await expect(userMessage).toHaveAttribute("aria-busy", "false");
  return userMessage;
}

async function stageProviderDesktop(
  page: Page,
  providerId: string,
  modelId: string,
): Promise<void> {
  await openModelPicker(page);
  const picker = page.getByTestId("combobox-desktop-container");
  const backButton = picker.getByTestId("sheet-header-back");
  if (await backButton.isVisible()) {
    await backButton.click();
  }
  await drillIntoProvider(page, providerId);
  await selectModelRow(page, { provider: providerId, modelId });
  await expect(page.getByTestId("staged-provider-switch-banner")).toBeVisible({ timeout: 30_000 });
}

async function stageDirectProviderDesktop(page: Page): Promise<void> {
  await stageProviderDesktop(page, DIRECT_PROVIDER.id, DIRECT_PROVIDER.modelId);
}

async function stageDirectProviderCompact(page: Page): Promise<void> {
  await page.getByTestId("combined-model-selector").filter({ visible: true }).first().click();
  await expect(page.getByTestId("agent-controls-model")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("agent-controls-model").click();
  const browserSheet = page.getByTestId("agent-controls-model-browser-sheet");
  const browserViewport = page.getByTestId("agent-controls-model-browser-viewport");
  await expect(browserViewport).toBeVisible({ timeout: 30_000 });
  const backButton = browserSheet.getByTestId("sheet-header-back");
  if (await backButton.isVisible()) {
    await backButton.click();
  }
  await browserViewport.getByTestId(`model-provider-${DIRECT_PROVIDER.id}`).click();
  await browserViewport
    .getByTestId(`model-row-${DIRECT_PROVIDER.id}-${DIRECT_PROVIDER.modelId}`)
    .click();
  await expect(browserViewport).toHaveCount(0, { timeout: 30_000 });
  // Dismiss the outer agent-controls sheet so the composer and banner are ready to submit.
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByTestId("agent-controls-model")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("staged-provider-switch-banner")).toBeVisible({ timeout: 30_000 });
}

async function rewindConversation(page: Page, userMessage: Locator, prompt: string): Promise<void> {
  await userMessage.getByText(prompt, { exact: true }).hover();
  await userMessage.getByRole("button", { name: "Rewind to this message", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rewind conversation", exact: true }).click();
}

test.describe.serial("Provider switching in chat", () => {
  let pluginClient: PluginInstallDaemonClient;
  let pluginFixture: Awaited<ReturnType<typeof copyPluginExample>>;
  let previousPluginsEnabled: boolean | undefined;

  test.beforeAll(async () => {
    pluginClient = await connectDaemonClient<PluginInstallDaemonClient>({
      clientIdPrefix: "provider-switching-e2e",
    });
    pluginFixture = await copyPluginExample("provider-direct");
    previousPluginsEnabled = (await pluginClient.getDaemonConfig()).config.pluginsEnabled;
    await pluginClient.patchDaemonConfig({ pluginsEnabled: true });
    await pluginClient.installDirectoryPlugin(pluginFixture.directory);
    await expect.poll(() => hasDirectProvider(pluginClient), { timeout: 30_000 }).toBe(true);
  });

  test.afterAll(async () => {
    await pluginClient?.removePlugin(DIRECT_PROVIDER.pluginId).catch(() => undefined);
    await pluginClient
      ?.patchDaemonConfig({ pluginsEnabled: previousPluginsEnabled })
      .catch(() => undefined);
    await pluginClient?.close().catch(() => undefined);
    await pluginFixture?.cleanup().catch(() => undefined);
  });

  test("stages, cancels, switches providers, inspects marker, scopes rewind, and survives reload", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1280, height: 800 });

    const preSwitchPrompt = "First prompt on Mock before switching.";
    const postSwitchPrompt = "Follow up on Direct provider after switching.";
    const postRewindPrompt = "Continue on Direct provider after rewinding.";

    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "provider-switch-desktop-",
      title: "Provider switch desktop",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await expectComposerMode(page, "Load test");

      const initialUrl = page.url();
      await completeMockTurn(page, workspace, preSwitchPrompt);

      await test.step("staging updates only draft state and Cancel restores the live provider", async () => {
        await stageDirectProviderDesktop(page);
        await expectComposerModel(page, DIRECT_PROVIDER.modelLabel);
        await expectComposerMode(page, DIRECT_PROVIDER.modeLabel);
        await expect(page.getByTestId("staged-provider-switch-banner")).toContainText(
          DIRECT_PROVIDER.label,
        );
        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: "mock",
          model: "e2e-fast-stream",
          modeId: "load-test",
        });
        // Editing a staged provider option must keep all staged option controls visible.
        const conciseToggle = page.getByRole("button", { name: /Concise responses/i }).first();
        const voiceSelect = page.getByRole("button", { name: /Voice/i }).first();
        await expect(conciseToggle).toBeVisible();
        await expect(voiceSelect).toBeVisible();
        await conciseToggle.click();
        await expect(conciseToggle).toBeVisible();
        await expect(voiceSelect).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await captureQaScreenshot(page, "desktop-staged-switch.png");

        await page.getByTestId("cancel-staged-provider-switch").click();
        await expect(page.getByTestId("staged-provider-switch-banner")).toHaveCount(0);
        await expectComposerMode(page, "Load test");

        // Returning to the live provider by choosing a different model clears the staged switch
        // and applies the newly chosen model directly to the live provider.
        await stageDirectProviderDesktop(page);
        await openModelPicker(page);
        const picker = page.getByTestId("combobox-desktop-container");
        const backButton = picker.getByTestId("sheet-header-back");
        if (await backButton.isVisible()) {
          await backButton.click();
        }
        await drillIntoProvider(page, "mock");
        await selectModelRow(page, { provider: "mock", modelId: "one-minute-stream" });
        await expect(page.getByTestId("staged-provider-switch-banner")).toHaveCount(0);
        await expectComposerModel(page, "One minute stream");
        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: "mock",
          model: "one-minute-stream",
          modeId: "load-test",
        });
      });

      await test.step("submitting commits the switch in place with clean user display text and inspectable marker", async () => {
        await stageDirectProviderDesktop(page);
        const switchedMessage = await completeDirectTurn(page, workspace, postSwitchPrompt);

        expect(page.url()).toBe(initialUrl);
        await expect(page.getByTestId("staged-provider-switch-banner")).toHaveCount(0);
        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: DIRECT_PROVIDER.id,
          model: DIRECT_PROVIDER.modelId,
          modeId: "build",
        });

        // Clean display text: handoff summary must never leak into the visible user bubble.
        await expect(switchedMessage).toContainText(postSwitchPrompt);
        await expect(switchedMessage).not.toContainText("<chat-history-summary>");

        // Direct provider echoes its prompt, proving bounded pre-switch context was attached.
        const directReply = page
          .getByTestId("assistant-message")
          .filter({ hasText: "Echo:" })
          .last();
        await expect(directReply).toContainText(preSwitchPrompt);
        await expect(directReply).toContainText(postSwitchPrompt);

        // Switch marker is visible and expands to show context handoff details.
        const marker = page.getByTestId("provider-switch-marker");
        await expect(marker).toBeVisible({ timeout: 30_000 });
        await marker.scrollIntoViewIfNeeded();
        await marker.getByTestId("provider-switch-marker-toggle").click();
        const details = marker.getByTestId("provider-switch-marker-details");
        await expect(details).toBeVisible();
        await expect(details).toContainText("Mock");
        await expect(details).toContainText(DIRECT_PROVIDER.label);
        await marker.scrollIntoViewIfNeeded();
        await expectNoHorizontalOverflow(page);
        await captureQaScreenshot(page, "desktop-switched-expanded.png");
        await marker.getByTestId("provider-switch-marker-toggle").click();
        await expect(details).toHaveCount(0);
      });

      await test.step("switching back to Mock enforces segment-scoped rewind and preserves pre-switch turns", async () => {
        const backToMockPrompt = "Switch back to Mock for segment-scoped rewind.";
        await stageProviderDesktop(page, "mock", "ten-second-stream");
        await expect(page.getByTestId("staged-provider-switch-banner")).toContainText("Mock");

        const backToMockMessage = await completeMockTurn(page, workspace, backToMockPrompt);
        await expect(backToMockMessage).not.toContainText("<chat-history-summary>");
        await expect(page.getByTestId("provider-switch-marker")).toHaveCount(2, {
          timeout: 30_000,
        });
        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: "mock",
          model: "ten-second-stream",
          modeId: "load-test",
        });

        // Pre-switch prompts from earlier segments must not expose rewind even though Mock supports it.
        const preSwitchMessage = page
          .getByTestId("user-message")
          .filter({ hasText: preSwitchPrompt });
        await preSwitchMessage.scrollIntoViewIfNeeded();
        await preSwitchMessage.getByText(preSwitchPrompt, { exact: true }).hover();
        await expect(
          preSwitchMessage.getByRole("button", { name: "Rewind to this message", exact: true }),
        ).toHaveCount(0);

        const directMessage = page
          .getByTestId("user-message")
          .filter({ hasText: postSwitchPrompt });
        await directMessage.scrollIntoViewIfNeeded();
        await directMessage.getByText(postSwitchPrompt, { exact: true }).hover();
        await expect(
          directMessage.getByRole("button", { name: "Rewind to this message", exact: true }),
        ).toHaveCount(0);

        // Post-switch prompt on Mock CAN rewind without retiring earlier segments or markers.
        await backToMockMessage.scrollIntoViewIfNeeded();
        await rewindConversation(page, backToMockMessage, backToMockPrompt);
        await expect(
          page.getByTestId("user-message").filter({ hasText: backToMockPrompt }),
        ).toHaveCount(0, { timeout: 30_000 });
        await expect(
          page.getByTestId("user-message").filter({ hasText: preSwitchPrompt }),
        ).toBeVisible();
        await expect(
          page.getByTestId("user-message").filter({ hasText: postSwitchPrompt }),
        ).toBeVisible();
        await expect(page.getByTestId("provider-switch-marker")).toHaveCount(2);

        // Continuing in the now-empty active segment completes cleanly.
        const retriedMessage = await completeMockTurn(page, workspace, postRewindPrompt);
        await expect(retriedMessage).not.toContainText("<chat-history-summary>");
      });

      await test.step("reload preserves the switched provider, markers, and rewind boundary", async () => {
        await page.reload();
        await expectComposerVisible(page);
        await expectComposerModel(page, "Ten second stream");
        await expectSwitchMarkerCountAfterScroll(page, 2);
        const reloadedDirect = page
          .getByTestId("user-message")
          .filter({ hasText: postSwitchPrompt });
        await expect(reloadedDirect).toBeVisible();
        await expect(
          page.getByTestId("user-message").filter({ hasText: postRewindPrompt }),
        ).toBeVisible();

        await reloadedDirect.scrollIntoViewIfNeeded();
        await reloadedDirect.getByText(postSwitchPrompt, { exact: true }).hover();
        await expect(
          reloadedDirect.getByRole("button", { name: "Rewind to this message", exact: true }),
        ).toHaveCount(0);
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("stages a switch mid-turn, queues the prompt, and switches cleanly between turns", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1280, height: 800 });

    const runningPrompt = "Run a ten-second mock turn first.";
    const queuedPrompt = "Queued handoff prompt for Direct provider.";

    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "provider-switch-midturn-",
      title: "Provider switch midturn",
      model: "ten-second-stream",
      modeId: "load-test",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);

      await submitMessage(page, runningPrompt);
      await expectAgentReadyToInterrupt(page);

      // Stage Direct provider while Mock is actively streaming.
      await stageDirectProviderDesktop(page);
      await expectWorkspaceAgentConfiguration(workspace, {
        id: workspace.agentId,
        provider: "mock",
        model: "ten-second-stream",
        modeId: "load-test",
      });

      // Submitting queues the prompt instead of racing the live turn.
      await submitMessage(page, queuedPrompt);
      await expectQueuedMessageButton(page);

      // Once the mock turn completes, the queue drains and commits the switch.
      await expect(page.getByTestId("provider-switch-marker")).toBeVisible({ timeout: 45_000 });
      await expect(page.getByTestId("staged-provider-switch-banner")).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(
        page.getByTestId("assistant-message").filter({ hasText: queuedPrompt }).last(),
      ).toBeVisible({ timeout: 30_000 });
      await expectAgentIdle(page);
      await expectWorkspaceAgentConfiguration(workspace, {
        id: workspace.agentId,
        provider: DIRECT_PROVIDER.id,
        model: DIRECT_PROVIDER.modelId,
        modeId: "build",
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("switches providers cleanly on a compact viewport with zero horizontal overflow", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 390, height: 844 });

    const preSwitchPrompt = "Compact turn on Mock.";
    const postSwitchPrompt = "Compact handoff on Direct.";

    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "provider-switch-compact-",
      title: "Provider switch compact",
      model: "e2e-fast-stream",
      modeId: "load-test",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);

      await submitMessageWithButton(page, preSwitchPrompt);
      await expect(
        page.getByTestId("user-message").filter({ hasText: preSwitchPrompt }),
      ).toBeVisible({ timeout: 30_000 });
      const firstFinish = await workspace.client.waitForFinish(workspace.agentId, 30_000);
      expect(firstFinish.status).toBe("idle");
      await expectAgentIdle(page);

      await stageDirectProviderCompact(page);
      await expectNoHorizontalOverflow(page);
      await captureQaScreenshot(page, "compact-staged-switch.png");

      const switchedMessage = await completeDirectTurn(page, workspace, postSwitchPrompt, {
        useSendButton: true,
      });
      await expect(switchedMessage).not.toContainText("<chat-history-summary>");

      const marker = page.getByTestId("provider-switch-marker");
      await expect(marker).toBeVisible({ timeout: 30_000 });
      await marker.scrollIntoViewIfNeeded();
      const toggle = marker.getByTestId("provider-switch-marker-toggle");
      const toggleBox = await toggle.boundingBox();
      expect(toggleBox).not.toBeNull();
      expect((toggleBox?.x ?? 0) + (toggleBox?.width ?? 0)).toBeLessThanOrEqual(390);
      await toggle.click();
      await expect(marker.getByTestId("provider-switch-marker-details")).toBeVisible();
      await marker.scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(page);
      await captureQaScreenshot(page, "compact-switched-expanded.png");
    } finally {
      await workspace.cleanup();
    }
  });
});
