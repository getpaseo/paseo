import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { createIdleAgent } from "../support/helpers/archive-tab";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewTerminal, terminalSurfaceLocator } from "../support/helpers/launcher";
import { renameModalInput } from "../support/helpers/rename";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { clickSettingsBackToWorkspace, openCompactSettings } from "../support/helpers/settings";
import { openSettings } from "../support/helpers/app";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import {
  clickFirstTerminalTab,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";
import { expectTerminalSurfaceVisible } from "../support/helpers/terminal-perf";

async function captureRenderedNode(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: 30_000 });
  const node = await locator.elementHandle();
  if (!node) {
    throw new Error("Expected rendered node");
  }
  return node;
}

async function expectSameRenderedNode(
  original: Awaited<ReturnType<typeof captureRenderedNode>>,
  locator: Locator,
) {
  const current = await captureRenderedNode(locator);
  await expect(original.evaluate((node, candidate) => node === candidate, current)).resolves.toBe(
    true,
  );
}

test.describe("Workspace pane mounting", () => {
  test("opening the first split pane keeps the existing agent composer mounted", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const serverId = getServerId();

    const workspace = await seedWorkspace({ repoPrefix: "pane-remount-" });

    try {
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `pane-remount-${Date.now()}`,
      });

      await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId));
      await page.waitForURL(
        (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
        { timeout: 60_000 },
      );
      await waitForWorkspaceTabsVisible(page);
      await expectComposerVisible(page);

      const originalComposer = await page
        .getByTestId("message-input-root")
        .filter({ visible: true })
        .first()
        .elementHandle();
      expect(originalComposer).not.toBeNull();
      const emptyPanesBeforeSplit = await page.getByTestId("workspace-new-tab-panel").count();

      await runWorkspaceActionFromCommandCenter(page, "Split pane right");
      await expect(page.getByTestId("workspace-new-tab-panel")).toHaveCount(
        emptyPanesBeforeSplit + 1,
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("message-input-root").filter({ visible: true })).toHaveCount(1);

      const originalStillConnected = await originalComposer!.evaluate((node) => node.isConnected);
      expect(originalStillConnected).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });

  test("opening Settings hides workspace overlays and keeps the agent composer mounted", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const serverId = getServerId();
    const workspace = await seedWorkspace({ repoPrefix: "settings-pane-retention-" });

    try {
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `settings-pane-retention-${Date.now()}`,
      });

      await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId));
      await waitForWorkspaceTabsVisible(page);
      const composer = page.getByTestId("message-input-root").filter({ visible: true }).first();
      const originalComposer = await captureRenderedNode(composer);

      const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`).first();
      await tab.click({ button: "right" });
      await page.getByTestId(`workspace-tab-context-agent_${agent.id}-rename`).click();
      const renameInput = renameModalInput(page, `workspace-tab-rename-modal-agent-${agent.id}`);
      await expect(renameInput).toBeVisible();

      const settingsShortcut = await page.evaluate(() =>
        navigator.platform.toLowerCase().includes("mac") ? "Meta+," : "Control+,",
      );
      await page.keyboard.press(settingsShortcut);
      await expect(page).toHaveURL(/\/settings\/general$/);
      await expect(renameInput).not.toBeVisible();
      await clickSettingsBackToWorkspace(page);
      await expectSameRenderedNode(originalComposer, composer);
    } finally {
      await workspace.cleanup();
    }
  });

  test("opening Settings on a compact layout keeps the agent composer mounted", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 480, height: 900 });
    const serverId = getServerId();
    const workspace = await seedWorkspace({ repoPrefix: "compact-settings-pane-retention-" });

    try {
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `compact-settings-pane-retention-${Date.now()}`,
      });
      const agentRoute = buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId);

      await page.goto(agentRoute);
      await expectComposerVisible(page);
      const composer = page.getByTestId("message-input-root").filter({ visible: true }).first();
      const originalComposer = await captureRenderedNode(composer);

      await openCompactSettings(page, buildHostWorkspaceRoute(serverId, workspace.workspaceId));
      await page.goBack();
      await page.waitForURL(
        (url) => url.pathname === buildHostWorkspaceRoute(serverId, workspace.workspaceId),
      );
      await expectSameRenderedNode(originalComposer, composer);
    } finally {
      await workspace.cleanup();
    }
  });

  test("switching away from a terminal tab keeps its emulator mounted", async ({ page }) => {
    test.setTimeout(90_000);
    const serverId = getServerId();
    const workspace = await seedWorkspace({ repoPrefix: "terminal-pane-retention-" });

    try {
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `terminal-pane-retention-${Date.now()}`,
      });

      await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId));
      await waitForWorkspaceTabsVisible(page);
      await clickNewTerminal(page);
      await expectTerminalSurfaceVisible(page);
      const terminalSurface = terminalSurfaceLocator(page);
      const originalTerminal = await captureRenderedNode(terminalSurface);

      await page.getByTestId(`workspace-tab-agent_${agent.id}`).click();
      await expectComposerVisible(page);
      expect(await originalTerminal.evaluate((node) => node.isConnected)).toBe(true);

      await clickFirstTerminalTab(page);
      await expectSameRenderedNode(originalTerminal, terminalSurface);
    } finally {
      await workspace.cleanup();
    }
  });

  test("opening Settings and returning keeps the terminal emulator mounted", async ({ page }) => {
    test.setTimeout(90_000);
    const serverId = getServerId();
    const workspace = await seedWorkspace({ repoPrefix: "settings-terminal-retention-" });

    try {
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `settings-terminal-retention-${Date.now()}`,
      });

      await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId));
      await waitForWorkspaceTabsVisible(page);
      await clickNewTerminal(page);
      await expectTerminalSurfaceVisible(page);
      const terminalSurface = terminalSurfaceLocator(page);
      const originalTerminal = await captureRenderedNode(terminalSurface);

      await openSettings(page);
      await clickSettingsBackToWorkspace(page);
      await expectSameRenderedNode(originalTerminal, terminalSurface);
    } finally {
      await workspace.cleanup();
    }
  });
});
