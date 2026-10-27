import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { createMockIdleAgent, openWorkspaceWithAgents } from "../support/helpers/archive-tab";
import { waitForTabBar, expectAgentTabActive } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

async function pressSettingsToggleShortcut(page: import("@playwright/test").Page) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+Comma`);
}

async function openComposerTab(page: import("@playwright/test").Page, agentId: string) {
  await page
    .getByTestId(`workspace-tab-agent_${agentId}`)
    .filter({ visible: true })
    .first()
    .click();
  await expectAgentTabActive(page, agentId);
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
}

interface ComposerFrame {
  at: number;
  visible: boolean;
  rootHeight: number;
  inputHeight: number;
  inputWidth: number;
  inputStyleHeight: string;
  inputStyleMaxHeight: string;
}

async function startComposerFrameCapture(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const capture = { frames: [] as ComposerFrame[], stopped: false };
    Object.assign(window, { __composerFrameCapture: capture });

    const sample = () => {
      if (capture.stopped) return;
      const root = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="message-input-root"]'),
      ).find((candidate) => candidate.offsetParent !== null);
      const input = root?.querySelector<HTMLTextAreaElement>("textarea");
      if (root && input) {
        const style = getComputedStyle(input);
        capture.frames.push({
          at: performance.now(),
          visible: root.offsetParent !== null,
          rootHeight: root.getBoundingClientRect().height,
          inputHeight: input.getBoundingClientRect().height,
          inputWidth: input.clientWidth,
          inputStyleHeight: style.height,
          inputStyleMaxHeight: style.maxHeight,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopComposerFrameCapture(
  page: import("@playwright/test").Page,
): Promise<ComposerFrame[]> {
  return page.evaluate(() => {
    const capture = (
      window as typeof window & {
        __composerFrameCapture?: { frames: ComposerFrame[]; stopped: boolean };
      }
    ).__composerFrameCapture;
    if (!capture) throw new Error("Composer frame capture was not installed");
    capture.stopped = true;
    return capture.frames;
  });
}

async function expectSendBehavior(
  page: import("@playwright/test").Page,
  expected: "interrupt" | "queue" | "steer",
) {
  await expect
    .poll(async () => {
      const raw = await page.evaluate(() => localStorage.getItem("@paseo:app-settings"));
      if (!raw) {
        return null;
      }
      return (JSON.parse(raw) as { sendBehavior?: string }).sendBehavior ?? null;
    })
    .toBe(expected);
}

async function openAgentRouteAndExpectFocused(input: {
  page: import("@playwright/test").Page;
  serverId: string;
  workspaceId: string;
  agentId: string;
}) {
  await input.page.goto(
    buildHostAgentDetailRoute(input.serverId, input.agentId, input.workspaceId),
  );
  await input.page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForTabBar(input.page);
  await expectAgentTabActive(input.page, input.agentId);
}

test.describe("Settings toggle tab regression", () => {
  test.describe.configure({ timeout: 180_000 });

  test("toggling settings after changing a setting returns to the same workspace tab", async ({
    page,
  }) => {
    const serverId = getServerId();
    const workspace = await seedWorkspace({ repoPrefix: "settings-toggle-tab-" });

    try {
      const firstAgent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `settings-toggle-a-${Date.now()}`,
      });
      const secondAgent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `settings-toggle-b-${Date.now()}`,
      });

      await openWorkspaceWithAgents(page, [firstAgent, secondAgent]);
      await waitForTabBar(page);
      await expectAgentTabActive(page, secondAgent.id);

      await pressSettingsToggleShortcut(page);
      await expect(page).toHaveURL(/\/settings\/general$/);

      const defaultSendTrigger = page.getByRole("button", {
        name: "Default send: Steer",
        exact: true,
      });
      await expect(defaultSendTrigger).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Queue", exact: true })).toHaveCount(0);

      await defaultSendTrigger.click();
      await expect(page.getByRole("menuitem", { name: "Steer", exact: true })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.getByRole("menuitem", { name: "Queue", exact: true }).click();
      await expectSendBehavior(page, "queue");
      const queuedDefaultSendTrigger = page.getByRole("button", {
        name: "Default send: Queue",
        exact: true,
      });
      await expect(queuedDefaultSendTrigger).toBeVisible();

      await queuedDefaultSendTrigger.click();
      await page.getByRole("menuitem", { name: "Interrupt", exact: true }).click();
      await expectSendBehavior(page, "interrupt");

      await pressSettingsToggleShortcut(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, workspace.workspaceId));
      await waitForTabBar(page);
      await expectAgentTabActive(page, secondAgent.id);

      await page.reload();
      await waitForTabBar(page);
      await expectAgentTabActive(page, secondAgent.id);
    } finally {
      await workspace.cleanup();
    }
  });

  test("returning from settings does not flash the composer at maximum height", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "settings-composer-height-" });

    try {
      const firstAgent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `settings-composer-height-a-${Date.now()}`,
      });
      const secondAgent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `settings-composer-height-b-${Date.now()}`,
      });
      await openWorkspaceWithAgents(page, [firstAgent, secondAgent]);
      await waitForTabBar(page);

      await openComposerTab(page, firstAgent.id);
      await openComposerTab(page, secondAgent.id);
      const input = page.getByRole("textbox", { name: "Message agent..." });
      await input.fill("Keep this short draft in the composer");
      const root = page.getByTestId("message-input-root").filter({ visible: true }).first();
      const baselineHeight = (await root.boundingBox())?.height;
      expect(baselineHeight).toBeDefined();

      await startComposerFrameCapture(page);
      await pressSettingsToggleShortcut(page);
      await expect(page).toHaveURL(/\/settings\/general$/);
      await pressSettingsToggleShortcut(page);
      await expect(page).not.toHaveURL(/\/settings(\/|$)/);
      await expect(input).toHaveValue("Keep this short draft in the composer");
      await page.waitForTimeout(250);

      const frames = await stopComposerFrameCapture(page);
      const visibleFrames = frames.filter((frame) => frame.visible);
      expect(visibleFrames.length, "Capture must observe the visible composer").toBeGreaterThan(0);
      const tallestIndex = visibleFrames.reduce(
        (index, frame, candidateIndex) =>
          frame.rootHeight > visibleFrames[index].rootHeight ? candidateIndex : index,
        0,
      );
      const tallestFrame = visibleFrames[tallestIndex];
      const tallestFrameIndex = frames.findIndex((frame) => frame.at === tallestFrame.at);
      expect(
        tallestFrame.rootHeight,
        JSON.stringify(
          {
            baselineHeight,
            tallestFrame,
            nearbyFrames: frames.slice(Math.max(0, tallestFrameIndex - 3), tallestFrameIndex + 4),
          },
          null,
          2,
        ),
      ).toBeLessThanOrEqual((baselineHeight ?? 0) + 5);
    } finally {
      await workspace.cleanup();
    }
  });

  test("refresh after navigating between agent routes keeps the latest agent focused", async ({
    page,
  }) => {
    const serverId = getServerId();
    const workspace = await seedWorkspace({ repoPrefix: "agent-route-refresh-" });

    try {
      const firstAgent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `agent-route-refresh-a-${Date.now()}`,
      });
      const secondAgent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `agent-route-refresh-b-${Date.now()}`,
      });

      await openAgentRouteAndExpectFocused({
        page,
        serverId,
        workspaceId: workspace.workspaceId,
        agentId: firstAgent.id,
      });
      await openAgentRouteAndExpectFocused({
        page,
        serverId,
        workspaceId: workspace.workspaceId,
        agentId: secondAgent.id,
      });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await page.reload();
        await waitForTabBar(page);
        await expectAgentTabActive(page, secondAgent.id);
      }
    } finally {
      await workspace.cleanup();
    }
  });
});

async function selectSendingOption(
  page: import("@playwright/test").Page,
  setting: string,
  option: string,
) {
  await page.getByRole("button", { name: new RegExp(`^${setting}:`) }).click();
  await page.getByRole("menuitem", { name: option, exact: true }).click();
  await expect(
    page.getByRole("button", { name: `${setting}: ${option}`, exact: true }),
  ).toBeVisible();
}

async function sendDraftWithShortcut(
  page: import("@playwright/test").Page,
  draft: string,
  shortcut: string,
) {
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await composer.fill(draft);
  await composer.press(shortcut);
  await expect(composer).toHaveValue("");
  await expect(page.getByText(draft, { exact: true })).toBeVisible();
}

test("send shortcut selection persists and controls the composer", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ repoPrefix: "send-shortcut-" });
  const modifierLabel = process.platform === "darwin" ? "⌘" : "Ctrl";
  try {
    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Send shortcut",
    });
    await openAgentRouteAndExpectFocused({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
      agentId: agent.id,
    });
    await openComposerTab(page, agent.id);
    const composer = page.getByRole("textbox", { name: "Message agent..." });

    await test.step("Enter sends by default", async () => {
      await sendDraftWithShortcut(page, "Default Enter submission", "Enter");
    });
    await test.step("choose the explicit modifier shortcut and retain it after reload", async () => {
      await pressSettingsToggleShortcut(page);
      await expect(
        page.getByRole("button", { name: "Send shortcut: Enter", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Send shortcut: Enter", exact: true }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["Enter", `${modifierLabel}+Enter`]);
      // Let the menu opening animation settle for visual QA.
      await page.waitForTimeout(300);
      await page.screenshot({ path: testInfo.outputPath("send-shortcut-selector.png") });
      await page.getByRole("menuitem", { name: `${modifierLabel}+Enter`, exact: true }).click();
      await page.reload();
      await expect(
        page.getByRole("button", { name: `Send shortcut: ${modifierLabel}+Enter`, exact: true }),
      ).toBeVisible();
      await pressSettingsToggleShortcut(page);
      await expect(composer).toBeVisible();
    });
    await test.step("Enter and Shift+Enter keep editing; modifier Enter sends", async () => {
      await composer.fill("First line");
      await composer.press("Enter");
      await expect(composer).toHaveValue("First line\n");
      await composer.press("Shift+Enter");
      await expect(composer).toHaveValue("First line\n\n");
      await sendDraftWithShortcut(page, "Sent with Control", "Control+Enter");
      await sendDraftWithShortcut(page, "Sent with Command", "Meta+Enter");
    });
    await test.step("switch back to Enter without changing the default send behavior", async () => {
      await pressSettingsToggleShortcut(page);
      await selectSendingOption(page, "Send shortcut", "Enter");
      await pressSettingsToggleShortcut(page);
      await composer.fill("Shift still edits");
      await composer.press("Shift+Enter");
      await expect(composer).toHaveValue("Shift still edits\n");
      await sendDraftWithShortcut(page, "Restored Enter submission", "Enter");
    });
  } finally {
    await workspace.cleanup();
  }
});

for (const behavior of ["Steer", "Interrupt", "Queue"] as const) {
  test(`modifier send shortcut follows ${behavior} while an agent runs`, async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "running-send-shortcut-",
      title: "Running send shortcut",
      model: "one-minute-stream",
    });
    const modifierLabel = process.platform === "darwin" ? "⌘" : "Ctrl";
    try {
      await openAgentRoute(page, agent);
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
      await pressSettingsToggleShortcut(page);
      await selectSendingOption(page, "Send shortcut", `${modifierLabel}+Enter`);
      await selectSendingOption(page, "Default send", behavior);
      await pressSettingsToggleShortcut(page);
      await sendDraftWithShortcut(page, "Stay running while I write a follow-up", "Control+Enter");
      await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeVisible();
      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await composer.fill("Follow-up");
      await composer.press("Enter");
      await expect(composer).toHaveValue("Follow-up\n");
      await composer.press("Control+Enter");
      await expect(composer).toHaveValue("");
      await expect(page.getByText("Follow-up", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Send queued message" })).toHaveCount(
        behavior === "Queue" ? 1 : 0,
      );
    } finally {
      await agent.cleanup();
    }
  });
}
