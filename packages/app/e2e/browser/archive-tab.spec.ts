import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { buildHostWorkspaceRoute, buildSessionsRoute } from "@/utils/host-routes";
import {
  closeActiveAgentWithShortcut,
  archiveAgentFromDaemon,
  archiveAgentFromSessions,
  clickSessionRow,
  createIdleAgent,
  expectArchivedAgentFocused,
  expectSessionRowArchived,
  expectSessionRowNotArchived,
  expectSessionRowVisible,
  expectWorkspaceArchiveOutcome,
  expectWorkspaceTabHidden,
  fetchAgentArchivedAt,
  openSessions,
  openWorkspaceWithAgents,
  primeAdditionalPage,
  resetSeededPageState,
  unarchiveAgentFromConversation,
  reloadWorkspace,
} from "../support/helpers/archive-tab";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectComposerDraft, fillComposerDraft, submitMessage } from "../support/helpers/composer";
import { awaitAssistantMessage, expectAgentIdle } from "../support/helpers/agent-stream";
import { expectAgentTabActive } from "../support/helpers/launcher";

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

  test("restoring a closed agent keeps its draft and updates open History on another client", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "archived-composer-",
      title: "Restore unsent draft",
    });
    const otherClient = await page.context().newPage();
    try {
      await openAgentRoute(page, agent);
      await submitMessage(page, "A completed conversation before closing");
      await awaitAssistantMessage(page);
      await expectAgentIdle(page);
      await fillComposerDraft(page, "Keep this unsent message after closing");
      await expectComposerDraft(page, "Keep this unsent message after closing");
      await closeActiveAgentWithShortcut(page, agent.agentId);
      await expect.poll(() => fetchAgentArchivedAt(agent.client, agent.agentId)).not.toBeNull();
      await page.reload();
      await openSessions(page);
      await expectSessionRowArchived(page, "Restore unsent draft");
      await test.step("Keep a second client on the archived History row", async () => {
        await otherClient.setViewportSize({ width: 390, height: 844 });
        await primeAdditionalPage(otherClient, buildSessionsRoute());
        await expectSessionRowArchived(otherClient, "Restore unsent draft");
      });
      await clickSessionRow(page, "Restore unsent draft");
      await expectArchivedAgentFocused(page, agent.agentId);
      await unarchiveAgentFromConversation(page);
      await expectComposerDraft(page, "Keep this unsent message after closing");
      await test.step("See the restored row on the second client without leaving History", async () => {
        await expectSessionRowNotArchived(otherClient, "Restore unsent draft");
        await expectSessionRowVisible(otherClient, "Restore unsent draft");
      });
      await test.step("See the same row become archived when its tab closes again", async () => {
        await closeActiveAgentWithShortcut(page, agent.agentId);
        await expectSessionRowArchived(otherClient, "Restore unsent draft");
      });
    } finally {
      await otherClient.close();
      await agent.cleanup();
    }
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
