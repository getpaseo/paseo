import { expect, type Page } from "@playwright/test";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { test } from "./fixtures";
import { seedWorkspace, type SeedDaemonClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import {
  observeLastAssistantFrames,
  observeTimelineSubscriptions,
} from "./helpers/timeline-delivery";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import { installDaemonWebSocketGate } from "./helpers/daemon-websocket-gate";
import {
  expectReconnectingToastGone,
  expectReconnectingToastVisible,
} from "./helpers/workspace-ui";

interface ViewedTimelineScenario {
  client: SeedDaemonClient;
  workspaceId: string;
  firstAgentId: string;
  secondAgentId: string;
  cleanup(): Promise<void>;
}

async function seedViewedTimelineScenario(): Promise<ViewedTimelineScenario> {
  const workspace = await seedWorkspace({ repoPrefix: "viewed-timelines-" });
  const createAgent = (title: string) =>
    workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title,
      modeId: "load-test",
      model: "ten-second-stream",
    });
  const [firstAgent, secondAgent] = await Promise.all([
    createAgent("First viewed chat"),
    createAgent("Second viewed chat"),
  ]);
  return {
    client: workspace.client,
    workspaceId: workspace.workspaceId,
    firstAgentId: firstAgent.id,
    secondAgentId: secondAgent.id,
    cleanup: workspace.cleanup,
  };
}

async function openAgent(page: Page, scenario: ViewedTimelineScenario, agentId: string) {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agentId, scenario.workspaceId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
  );
  await waitForWorkspaceTabsVisible(page);
}

async function selectAgent(page: Page, title: string) {
  await page.getByRole("button", { name: title, exact: true }).click();
}

async function enableMoveTabShortcut(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
}

async function moveActiveTabRight(page: Page) {
  await page.keyboard.press("Meta+Alt+Shift+ArrowRight");
}

async function commitMessage(scenario: ViewedTimelineScenario, agentId: string, prompt: string) {
  await scenario.client.sendAgentMessage(agentId, prompt);
  const finish = await scenario.client.waitForFinish(agentId, 30_000);
  expect(finish.status).toBe("idle");
}

test.describe("Viewed agent timelines", () => {
  test("a focused turn streams live and resumes its hidden remainder atomically", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const subscriptions = observeTimelineSubscriptions(page);
    const scenario = await seedViewedTimelineScenario();
    try {
      await openAgent(page, scenario, scenario.firstAgentId);
      await subscriptions.waitForSubscribedAgents([scenario.firstAgentId]);

      await scenario.client.sendAgentMessage(
        scenario.firstAgentId,
        "Stream while focused, then finish while hidden.",
      );
      await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible();
      await expect(
        page.getByTestId("assistant-message").filter({ hasText: "Cycle 1" }).first(),
      ).toBeVisible();
      await expect(page.getByText("(end of synthetic stream)", { exact: true })).toHaveCount(0);

      await selectAgent(page, "Second viewed chat");
      await subscriptions.waitForSubscribedAgents([scenario.secondAgentId]);
      const finish = await scenario.client.waitForFinish(scenario.firstAgentId, 30_000);
      expect(finish.status).toBe("idle");

      const assistantFrames = await observeLastAssistantFrames(page);
      await selectAgent(page, "First viewed chat");
      await expect(page.getByText("(end of synthetic stream)", { exact: true })).toBeVisible();
      const snapshots = await assistantFrames.stop();

      expect(snapshots[0]).toContain("(end of synthetic stream)");
    } finally {
      await scenario.cleanup();
    }
  });

  test("a hidden retained chat catches up when shown", async ({ page }) => {
    const scenario = await seedViewedTimelineScenario();
    try {
      await openAgent(page, scenario, scenario.firstAgentId);
      await selectAgent(page, "Second viewed chat");
      await commitMessage(
        scenario,
        scenario.firstAgentId,
        "Committed while the first chat is hidden.",
      );
      await expect(
        page.getByText("Committed while the first chat is hidden.", { exact: true }),
      ).toHaveCount(0);
      await selectAgent(page, "First viewed chat");
      await expect(
        page.getByText("Committed while the first chat is hidden.", { exact: true }),
      ).toBeVisible();
    } finally {
      await scenario.cleanup();
    }
  });

  test("two visible split chats both stay current", async ({ page }) => {
    const scenario = await seedViewedTimelineScenario();
    try {
      await enableMoveTabShortcut(page);
      await openAgent(page, scenario, scenario.firstAgentId);
      await page.getByRole("button", { name: "Split pane right" }).click();
      await selectAgent(page, "Second viewed chat");
      await moveActiveTabRight(page);
      await expect(
        page.getByRole("button", { name: "First viewed chat", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Second viewed chat", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveCount(2);
      await commitMessage(scenario, scenario.firstAgentId, "First visible pane update.");
      await expect(page.getByText("First visible pane update.", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Second viewed chat", exact: true }),
      ).toBeVisible();
    } finally {
      await scenario.cleanup();
    }
  });

  test("a visible chat catches up after reconnecting", async ({ page }) => {
    const gate = await installDaemonWebSocketGate(page);
    const scenario = await seedViewedTimelineScenario();
    try {
      await openAgent(page, scenario, scenario.firstAgentId);
      await expect(page.getByRole("button", { name: "First viewed chat" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await gate.drop();
      await expectReconnectingToastVisible(page);
      await commitMessage(scenario, scenario.firstAgentId, "Committed while the chat reconnects.");
      await expect(
        page.getByText("Committed while the chat reconnects.", { exact: true }),
      ).toHaveCount(0);
      gate.restore();
      await expectReconnectingToastGone(page);
      const recoveredMessage = page.getByText("Committed while the chat reconnects.", {
        exact: true,
      });
      await expect(recoveredMessage).toHaveCount(1);
      await expect(recoveredMessage).toBeVisible();
    } finally {
      gate.restore();
      await scenario.cleanup();
    }
  });
});
