import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import path from "node:path";
import { buildHostSessionsRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import { test, expect, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveAgentFromDaemon,
  connectArchiveTabDaemonClient,
  createIdleAgent,
  expectWorkspaceTabVisible,
  type ArchiveTabAgent,
} from "./helpers/archive-tab";
import {
  archiveLocalWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
  type OpenedProject,
} from "./helpers/new-workspace";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import { expectSidebarWorkspaceSelected, waitForSidebarHydration } from "./helpers/workspace-ui";

interface SeededSidebarSessions {
  firstWorkspace: OpenedProject;
  secondWorkspace: OpenedProject;
  firstProjectName: string;
  secondProjectName: string;
  unmappedProjectName: string;
  agentsByNewest: [ArchiveTabAgent, ArchiveTabAgent, ArchiveTabAgent];
  unmappedAgent: ArchiveTabAgent;
  cleanupRepos: () => Promise<void>;
}

function requireServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

function uniqueTitle(label: string): string {
  return `sidebar-history-${label}-${randomUUID().slice(0, 8)}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkoutBranch(repoPath: string, branch: string): void {
  execSync(`git checkout ${JSON.stringify(branch)}`, {
    cwd: repoPath,
    stdio: "ignore",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedSidebarSessionsJourney(clients: {
  archiveClient: Awaited<ReturnType<typeof connectArchiveTabDaemonClient>>;
  workspaceClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
}): Promise<SeededSidebarSessions> {
  const firstRepo = await createTempGitRepo("sidebar-history-a-", { branches: ["feature-a"] });
  const secondRepo = await createTempGitRepo("sidebar-history-b-", { branches: ["feature-b"] });
  const unmappedRepo = await createTempGitRepo("sidebar-history-unmapped-");
  const workspaceIds: string[] = [];
  const agentIds: string[] = [];

  try {
    checkoutBranch(firstRepo.path, "feature-a");
    checkoutBranch(secondRepo.path, "feature-b");

    const firstWorkspace = await openProjectViaDaemon(clients.workspaceClient, firstRepo.path);
    const secondWorkspace = await openProjectViaDaemon(clients.workspaceClient, secondRepo.path);
    workspaceIds.push(firstWorkspace.workspaceId, secondWorkspace.workspaceId);

    const oldest = await createIdleAgent(clients.archiveClient, {
      cwd: firstRepo.path,
      title: uniqueTitle("oldest"),
    });
    await sleep(20);
    const middle = await createIdleAgent(clients.archiveClient, {
      cwd: firstRepo.path,
      title: uniqueTitle("middle"),
    });
    await sleep(20);
    const newest = await createIdleAgent(clients.archiveClient, {
      cwd: secondRepo.path,
      title: uniqueTitle("newest"),
    });
    const unmappedAgent = await createIdleAgent(clients.archiveClient, {
      cwd: unmappedRepo.path,
      title: uniqueTitle("unmapped"),
    });
    await archiveLocalWorkspaceFromDaemon(clients.workspaceClient, unmappedRepo.path);
    agentIds.push(oldest.id, middle.id, newest.id, unmappedAgent.id);

    return {
      firstWorkspace,
      secondWorkspace,
      firstProjectName: path.basename(firstRepo.path),
      secondProjectName: path.basename(secondRepo.path),
      unmappedProjectName: path.basename(unmappedRepo.path),
      agentsByNewest: [newest, middle, oldest],
      unmappedAgent,
      cleanupRepos: async () => {
        await unmappedRepo.cleanup();
        await secondRepo.cleanup();
        await firstRepo.cleanup();
      },
    };
  } catch (error) {
    for (const agentId of agentIds) {
      await archiveAgentFromDaemon(clients.archiveClient, agentId).catch(() => undefined);
    }
    for (const workspaceId of workspaceIds) {
      await archiveLocalWorkspaceFromDaemon(clients.workspaceClient, workspaceId).catch(
        () => undefined,
      );
    }
    await secondRepo.cleanup();
    await firstRepo.cleanup();
    await unmappedRepo.cleanup();
    throw error;
  }
}

async function cleanupSeededSidebarSessions(
  seeded: SeededSidebarSessions | null,
  clients: {
    archiveClient: Awaited<ReturnType<typeof connectArchiveTabDaemonClient>>;
    workspaceClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  },
): Promise<void> {
  if (!seeded) {
    return;
  }

  for (const agent of seeded.agentsByNewest) {
    await archiveAgentFromDaemon(clients.archiveClient, agent.id).catch(() => undefined);
  }
  await archiveAgentFromDaemon(clients.archiveClient, seeded.unmappedAgent.id).catch(
    () => undefined,
  );
  await archiveLocalWorkspaceFromDaemon(clients.workspaceClient, seeded.unmappedAgent.cwd).catch(
    () => undefined,
  );
  await archiveLocalWorkspaceFromDaemon(
    clients.workspaceClient,
    seeded.secondWorkspace.workspaceId,
  ).catch(() => undefined);
  await archiveLocalWorkspaceFromDaemon(
    clients.workspaceClient,
    seeded.firstWorkspace.workspaceId,
  ).catch(() => undefined);
  await seeded.cleanupRepos();
}

async function openAppWithSeededWorkspaces(page: Page, seeded: SeededSidebarSessions) {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await expectWorkspaceTreeVisible(page, seeded);
}

function expectSeededAgentsHaveDeterministicCreatedAtOrder(seeded: SeededSidebarSessions) {
  const [newest, middle, oldest] = seeded.agentsByNewest;
  expect(new Date(newest.createdAt).getTime()).toBeGreaterThan(
    new Date(middle.createdAt).getTime(),
  );
  expect(new Date(middle.createdAt).getTime()).toBeGreaterThan(
    new Date(oldest.createdAt).getTime(),
  );
}

async function expectWorkspaceTreeVisible(page: Page, seeded: SeededSidebarSessions) {
  await expect(page.getByRole("button", { name: "Workspaces" })).toBeVisible();
  await expect(page.getByText(seeded.firstProjectName, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(seeded.firstWorkspace.workspaceName, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(seeded.secondProjectName, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(seeded.secondWorkspace.workspaceName, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Filter sessions" })).toHaveCount(0);
}

async function switchSidebarToSessions(page: Page) {
  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.getByRole("button", { name: "Filter sessions" })).toBeVisible({
    timeout: 30_000,
  });
}

async function switchSidebarToWorkspaces(page: Page, seeded: SeededSidebarSessions) {
  await page.getByRole("button", { name: "Workspaces" }).click();
  await expectWorkspaceTreeVisible(page, seeded);
  for (const agent of seeded.agentsByNewest) {
    await expect(sessionRow(page, agent)).toHaveCount(0);
  }
}

function sessionRow(page: Page, agent: ArchiveTabAgent) {
  return page.getByRole("button", { name: new RegExp(escapeRegex(agent.title)) });
}

async function expectSidebarSessionRows(page: Page, agents: readonly ArchiveTabAgent[]) {
  for (const agent of agents) {
    await expect(sessionRow(page, agent)).toBeVisible({ timeout: 30_000 });
  }
}

async function expectOnlySidebarSessionRows(
  page: Page,
  input: {
    visible: readonly ArchiveTabAgent[];
    hidden: readonly ArchiveTabAgent[];
  },
) {
  await expectSidebarSessionRows(page, input.visible);
  for (const agent of input.hidden) {
    await expect(sessionRow(page, agent)).toHaveCount(0);
  }
}

async function expectUnmappedSessionHidden(page: Page, seeded: SeededSidebarSessions) {
  await expect(sessionRow(page, seeded.unmappedAgent)).toHaveCount(0);
  await page.getByRole("button", { name: "Filter sessions" }).click();
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^${escapeRegex(seeded.unmappedProjectName)}$`),
    }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function expectNewestSessionRowFirst(page: Page, newest: ArchiveTabAgent) {
  await expect(sessionRow(page, newest)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const titles = await page.getByRole("button").allTextContents();
      return titles.find((title) => title.includes("sidebar-history-")) ?? "";
    })
    .toContain(newest.title);
}

async function chooseSessionsFilter(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name: "Filter sessions" }).click();
  await page.getByRole("button", { name }).click();
}

async function chooseProjectSessionsFilter(page: Page, projectName: string) {
  await chooseSessionsFilter(page, new RegExp(`^${escapeRegex(projectName)}$`));
}

async function openFirstWorkspace(page: Page, seeded: SeededSidebarSessions) {
  const serverId = requireServerId();
  await page.goto(buildHostWorkspaceRoute(serverId, seeded.firstWorkspace.workspaceId));
  await waitForWorkspaceTabsVisible(page);
  await expectSidebarWorkspaceSelected({
    page,
    serverId,
    workspaceId: seeded.firstWorkspace.workspaceId,
  });
}

async function navigateFromSessionRow(page: Page, agent: ArchiveTabAgent) {
  await sessionRow(page, agent).click();
}

async function expectWorkspaceFocusedOnSession(
  page: Page,
  input: { workspaceId: string; agent: ArchiveTabAgent },
) {
  const serverId = requireServerId();
  await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, input.workspaceId), {
    timeout: 30_000,
  });
  await waitForWorkspaceTabsVisible(page);
  await expectWorkspaceTabVisible(page, input.agent.id);
  await expect(
    page.getByTestId(`workspace-tab-agent_${input.agent.id}`).filter({ visible: true }).first(),
  ).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
}

async function openHistoryFromSidebar(page: Page) {
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(buildHostSessionsRoute(requireServerId()), {
    timeout: 30_000,
  });
}

async function runSidebarHistorySessionsJourney(page: Page) {
  const archiveClient = await connectArchiveTabDaemonClient();
  const workspaceClient = await connectNewWorkspaceDaemonClient();
  let seeded: SeededSidebarSessions | null = null;

  try {
    seeded = await seedSidebarSessionsJourney({ archiveClient, workspaceClient });
    expectSeededAgentsHaveDeterministicCreatedAtOrder(seeded);
    const [newest, middle, oldest] = seeded.agentsByNewest;

    await openAppWithSeededWorkspaces(page, seeded);
    await switchSidebarToSessions(page);
    await expectSidebarSessionRows(page, seeded.agentsByNewest);
    await expectUnmappedSessionHidden(page, seeded);
    await expectNewestSessionRowFirst(page, newest);
    await switchSidebarToWorkspaces(page, seeded);

    await switchSidebarToSessions(page);
    await chooseProjectSessionsFilter(page, seeded.secondProjectName);
    await expectOnlySidebarSessionRows(page, {
      visible: [newest],
      hidden: [middle, oldest],
    });
    await chooseSessionsFilter(page, "All");
    await expectSidebarSessionRows(page, seeded.agentsByNewest);

    await openFirstWorkspace(page, seeded);
    await switchSidebarToSessions(page);
    await navigateFromSessionRow(page, newest);
    await expectWorkspaceFocusedOnSession(page, {
      workspaceId: seeded.secondWorkspace.workspaceId,
      agent: newest,
    });

    await openHistoryFromSidebar(page);
  } finally {
    await cleanupSeededSidebarSessions(seeded, { archiveClient, workspaceClient });
    await archiveClient.close().catch(() => undefined);
    await workspaceClient.close().catch(() => undefined);
  }
}

test.describe("Sidebar History Sessions journey", () => {
  test.describe.configure({ timeout: 300_000 });

  test("toggles sessions, filters by project, and opens a session tab", async ({ page }) => {
    await runSidebarHistorySessionsJourney(page);
  });
});
