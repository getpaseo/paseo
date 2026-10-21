import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { AGENT_NOTIFICATIONS_MUTED_LABEL } from "@getpaseo/protocol/agent-labels";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "../support/fixtures";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";
import {
  clickSessionRow,
  createMockIdleAgent,
  expectArchivedAgentFocused,
  expectWorkspaceTabVisible,
  openSessions,
} from "../support/helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import { getServerId } from "../support/helpers/server-id";

async function openAgentInWorkspace(
  page: Page,
  agent: { id: string; workspaceId: string },
  compact = false,
) {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.workspaceId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  if (compact) {
    await expect(page.getByTestId("workspace-tab-switcher-trigger")).toBeVisible();
  } else {
    await waitForWorkspaceTabsVisible(page);
    await expectWorkspaceTabVisible(page, agent.id);
  }
}

async function fetchAgentTitle(client: SeedDaemonClient, agentId: string): Promise<string | null> {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
}

test.describe("Workspace agent tab actions", () => {
  test("right-click rename persists the agent title and updates the tab label", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-agent-rename-" });

    try {
      const initialTitle = `agent-rename-${randomUUID().slice(0, 8)}`;
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: initialTitle,
      });

      await openAgentInWorkspace(page, agent);

      const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`).first();
      await expect(tab).toContainText(initialTitle, { timeout: 15_000 });

      await tab.click({ button: "right" });
      await expect(page.getByTestId(`workspace-tab-context-agent_${agent.id}`)).toBeVisible({
        timeout: 10_000,
      });
      const renameItem = page.getByTestId(`workspace-tab-context-agent_${agent.id}-rename`);
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();

      const modalPrefix = `workspace-tab-rename-modal-agent-${agent.id}`;
      const input = renameModalInput(page, modalPrefix);
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(input).toHaveValue(initialTitle);

      const renamed = "My Renamed Agent";
      await input.fill(renamed);
      await renameModalSubmit(page, modalPrefix).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(tab).toContainText(renamed, { timeout: 15_000 });
      await expect.poll(() => fetchAgentTitle(workspace.client, agent.id)).toBe(renamed);
    } finally {
      await workspace.cleanup();
    }
  });
});

async function agentRecordPath(agentId: string): Promise<string> {
  const home = process.env.E2E_PASEO_HOME;
  if (!home) throw new Error("Expected the isolated E2E daemon home");
  const agents = path.join(home, "agents");
  for (const directory of await readdir(agents, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const entries = await readdir(path.join(agents, directory.name));
    if (entries.includes(`${agentId}.json`)) {
      return path.join(agents, directory.name, `${agentId}.json`);
    }
  }
  throw new Error(`Missing persisted record for agent ${agentId}`);
}

async function persistedAgent(recordPath: string): Promise<unknown> {
  return JSON.parse(await readFile(recordPath, "utf8"));
}

async function openAgentTabMenu(page: Page, agentId: string, compact = false) {
  if (compact) {
    await page.getByTestId("workspace-tab-switcher-trigger").click();
    await page.getByTestId(`workspace-tab-menu-agent_${agentId}-trigger`).click();
  } else {
    await page.getByTestId(`workspace-tab-agent_${agentId}`).first().click({ button: "right" });
  }
  const prefix = compact ? "workspace-tab-menu" : "workspace-tab-context";
  const menu = page.getByTestId(`${prefix}-agent_${agentId}`);
  const action = page.getByTestId(`${prefix}-agent_${agentId}-notification-mute`);
  return { menu, action };
}

async function openNotificationMenu(page: Page, agentId: string, compact = false) {
  const { action } = await openAgentTabMenu(page, agentId, compact);
  await expect(action).toBeVisible();
  return action;
}

test("archived history tabs omit notification mute", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "archived-agent-notification-mute-" });
  try {
    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Archived communication helper",
    });
    await openAgentInWorkspace(page, agent);
    await openNotificationMenu(page, agent.id);
    await page.keyboard.press("Escape");
    const { archivedAt } = await workspace.client.archiveAgent(agent.id);
    await openSessions(page);
    await clickSessionRow(page, agent.title);
    await expectArchivedAgentFocused(page, agent.id);
    const { menu, action } = await openAgentTabMenu(page, agent.id);
    await expect(menu.getByText("Copy agent id", { exact: true })).toBeVisible();
    await expect(action).toHaveCount(0);
    expect((await workspace.client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt).toBe(
      archivedAt,
    );
  } finally {
    await workspace.cleanup();
  }
});

for (const compact of [false, true]) {
  test(`notification mute persists and can be undone from the ${compact ? "compact switcher" : "right-click menu"}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    if (compact) await page.setViewportSize({ width: 390, height: 844 });
    const workspace = await seedWorkspace({ repoPrefix: "agent-notification-mute-" });
    try {
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Cross-machine helper",
      });
      await workspace.client.updateAgent(agent.id, { labels: { purpose: "communication" } });
      const recordPath = await agentRecordPath(agent.id);
      await openAgentInWorkspace(page, agent, compact);
      const action = await openNotificationMenu(page, agent.id, compact);
      await expect(action).toHaveText("Mute completion alerts");
      await action.click();
      await expect(action).toHaveText("Unmute completion alerts");
      await expect
        .poll(() => persistedAgent(recordPath))
        .toMatchObject({
          labels: { purpose: "communication", [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" },
        });
      await page.screenshot({ path: testInfo.outputPath("agent-notifications-muted.png") });

      await page.reload();
      if (compact) await expect(page.getByTestId("workspace-tab-switcher-trigger")).toBeVisible();
      else await waitForWorkspaceTabsVisible(page);
      const reloadedAction = await openNotificationMenu(page, agent.id, compact);
      await expect(reloadedAction).toHaveText("Unmute completion alerts");
      await reloadedAction.click();
      await expect(reloadedAction).toHaveText("Mute completion alerts");
      await expect
        .poll(() => persistedAgent(recordPath))
        .toMatchObject({
          labels: { purpose: "communication", [AGENT_NOTIFICATIONS_MUTED_LABEL]: "false" },
        });
      await page.screenshot({ path: testInfo.outputPath("agent-notifications-unmuted.png") });
    } finally {
      await workspace.cleanup();
    }
  });
}

test("notification mute keeps a real persistence failure visible and retries", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "agent-notification-mute-failure-" });
  let restoreRecord: (() => Promise<void>) | undefined;
  try {
    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Retry notification settings",
    });
    await openAgentInWorkspace(page, agent);
    const action = await openNotificationMenu(page, agent.id);
    const recordPath = await agentRecordPath(agent.id);
    const backupPath = `${recordPath}.saved`;
    // The daemon really attempts its atomic rename, which fails against a directory. Keep the
    // original record beside it and restore it before retrying; no mocked transport or response.
    await rename(recordPath, backupPath);
    restoreRecord = async () => {
      await rm(recordPath, { recursive: true, force: true });
      await rename(backupPath, recordPath);
    };
    await mkdir(recordPath);
    await action.click();
    await expect(action).toContainText("Save failed. Select to retry.");
    await expect(action).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("agent-notification-mute-failure.png") });
    await restoreRecord();
    restoreRecord = undefined;
    await action.click();
    await expect(action).toHaveText("Unmute completion alerts");
    await expect(page.getByText("Save failed. Select to retry.", { exact: true })).toHaveCount(0);
    await expect
      .poll(() => persistedAgent(recordPath))
      .toMatchObject({
        labels: { [AGENT_NOTIFICATIONS_MUTED_LABEL]: "true" },
      });
  } finally {
    await restoreRecord?.();
    await workspace.cleanup();
  }
});
