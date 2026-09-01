import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { createIdleAgent, openWorkspaceWithAgents } from "../support/helpers/archive-tab";
import { waitForTabBar, expectAgentTabActive } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

async function pressSettingsToggleShortcut(page: import("@playwright/test").Page) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+Comma`);
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
      const root = document.querySelector<HTMLElement>('[data-testid="message-input-root"]');
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
      const firstAgent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `settings-toggle-a-${Date.now()}`,
      });
      const secondAgent = await createIdleAgent(workspace.client, {
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
      const firstAgent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `settings-composer-height-a-${Date.now()}`,
      });
      const secondAgent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `settings-composer-height-b-${Date.now()}`,
      });
      await openWorkspaceWithAgents(page, [firstAgent, secondAgent]);
      await waitForTabBar(page);

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
      const firstAgent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `agent-route-refresh-a-${Date.now()}`,
      });
      const secondAgent = await createIdleAgent(workspace.client, {
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
