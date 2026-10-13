import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import {
  archiveAgentFromDaemon,
  archiveAgentFromSessions,
  clickSessionRow,
  createIdleAgent,
  createMockIdleAgent,
  closeWorkspaceAgentTab,
  expectArchivedAgentFocused,
  expectSessionRowArchived,
  expectSessionRowVisible,
  expectWorkspaceArchiveOutcome,
  expectWorkspaceTabHidden,
  fetchAgentArchivedAt,
  openSessions,
  openWorkspaceWithAgents,
  primeAdditionalPage,
  resetSeededPageState,
  reloadWorkspace,
} from "../support/helpers/archive-tab";
import { expectAgentTabActive } from "../support/helpers/launcher";

async function injectWorkspaceHistoryFailures(page: Page) {
  const failures = new Set(["fetch_agent_history_request", "refresh_agent_request"]);
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const envelope = JSON.parse(message.toString());
      const request = envelope.type === "session" ? envelope.message : null;
      if (request && failures.has(request.type)) {
        ws.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: {
                requestId: request.requestId,
                requestType: request.type,
                code: "transport",
                error: "Connection interrupted. Please retry.",
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  return failures;
}

test.describe("Archive tab reconciliation", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;
  let workspaceId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("archive-tab-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    workspaceId = created.workspace.id;
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  test("workspace history reopens a closed conversation without mixing worktrees", async ({
    page,
  }, testInfo) => {
    const closed = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: "Review the workspace history",
    });
    const active = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: "Current conversation",
    });
    const otherWorkspace = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
    });
    const other = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId: otherWorkspace.workspace!.id,
      title: "Conversation in another workspace",
    });
    await client.archiveAgent(other.id);
    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [closed, active]);
    await page
      .getByTestId(`workspace-tab-agent_${closed.id}`)
      .filter({ visible: true })
      .first()
      .hover();
    await closeWorkspaceAgentTab(page, closed.id);
    const trigger = page.getByTestId("workspace-history-trigger").filter({ visible: true });
    await page.mouse.move(500, 300);
    await expect(trigger).toHaveCSS("opacity", "0");
    await page.getByTestId("workspace-tabs-row").filter({ visible: true }).first().hover();
    await expect(trigger).toHaveCSS("opacity", "1");
    await page.mouse.move(500, 300);
    await trigger.focus();
    await expect(trigger).toHaveCSS("opacity", "1");
    await trigger.press("Enter");
    await expect(page.getByTestId(`workspace-history-agent-${closed.id}`)).toBeVisible();
    await expect(page.getByTestId(`workspace-history-agent-${other.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`workspace-history-agent-${active.id}`)).toHaveCount(0);
    await expect(page.getByTestId("workspace-history-menu")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: testInfo.outputPath("workspace-history-menu.png"),
      animations: "disabled",
    });
    await page.getByTestId(`workspace-history-agent-${closed.id}`).click();
    await expectAgentTabActive(page, closed.id);
    await expect.poll(() => fetchAgentArchivedAt(client, closed.id)).toBeNull();
    await expect(page.getByText("This agent is archived", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Updating messages", { exact: true })).toHaveCount(0);
    await expect(
      page
        .getByText("Start chatting with this agent...", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("workspace-history-reopened.png"),
      animations: "disabled",
    });
  });

  test("workspace history on compact screens keeps errors actionable and allows retry", async ({
    page,
  }, testInfo) => {
    const archived = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: "Resume after a connection error",
    });
    await client.archiveAgent(archived.id);
    const failures = await injectWorkspaceHistoryFailures(page);
    await resetSeededPageState(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), workspaceId));
    await page.getByTestId("workspace-history-trigger").filter({ visible: true }).click();
    await expect(page.getByText("Could not load conversations.", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    failures.delete("fetch_agent_history_request");
    await page.getByText("Retry", { exact: true }).click({ timeout: 10_000 });
    const row = page.getByTestId(`workspace-history-agent-${archived.id}`);
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByTestId("workspace-history-error")).toContainText(
      "Connection interrupted.",
    );
    expect(await fetchAgentArchivedAt(client, archived.id)).not.toBeNull();
    await expect(row).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("workspace-history-compact-error.png") });
    failures.delete("refresh_agent_request");
    await row.click();
    await expect.poll(() => fetchAgentArchivedAt(client, archived.id)).toBeNull();
    await expect(page.getByTestId("workspace-history-error")).toHaveCount(0);
  });

  test("non-UI archive prunes the archived tab across open pages and reload", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openSessions(page);
      await expectSessionRowVisible(page, archived.title);
      await expectSessionRowVisible(page, surviving.title);
      await openSessions(passivePage);
      await expectSessionRowVisible(passivePage, archived.title);
      await expectSessionRowVisible(passivePage, surviving.title);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await archiveAgentFromDaemon(client, archived.id);
      await expectWorkspaceArchiveOutcome(page, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await reloadWorkspace(passivePage, surviving.workspaceId);
      await expectWorkspaceTabHidden(passivePage, archived.id);
    } finally {
      await passivePage.close();
    }
  });

  test("Sessions archive prunes the archived tab across open pages", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await openSessions(page);
      await archiveAgentFromSessions(page, { agentId: archived.id, title: archived.title });
      await reloadWorkspace(page, surviving.workspaceId);
      await expectWorkspaceTabHidden(page, archived.id);
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
    } finally {
      await passivePage.close();
    }
  });

  test("clicking an archived session navigates without unarchiving it", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-archived-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-control-${randomUUID().slice(0, 8)}`,
    });

    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [archived, surviving]);
    await archiveAgentFromDaemon(client, archived.id);
    const archivedAt = await fetchAgentArchivedAt(client, archived.id);
    expect(archivedAt).not.toBeNull();
    await openSessions(page);
    await expectSessionRowArchived(page, archived.title);

    await clickSessionRow(page, archived.title);

    await expectArchivedAgentFocused(page, archived.id);
    await expectAgentTabActive(page, archived.id);
    expect(await fetchAgentArchivedAt(client, archived.id)).toBe(archivedAt);

    await expect(page).toHaveURL(buildHostWorkspaceRoute(getServerId(), archived.workspaceId), {
      timeout: 30_000,
    });
  });
});
