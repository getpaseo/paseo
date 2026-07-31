import { existsSync } from "node:fs";
import { expect, test, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { clickSessionRow, expectSessionRowArchived, openSessions } from "./helpers/archive-tab";
import {
  cloneGithubRepoDefaultBranchOnly,
  createTempGithubRepo,
  hasGithubAuth,
  type GhDefaultBranchClone,
  type GhRepoFixture,
} from "./helpers/github-fixtures";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
} from "./helpers/new-workspace";
import { connectSeedClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { waitForSidebarHydration, waitForWorkspaceInSidebar } from "./helpers/workspace-ui";

const GITHUB_AUTH = hasGithubAuth();

test.describe("Auto-archive after pull request merge", () => {
  test.describe.configure({ retries: 0, timeout: 180_000 });

  test.beforeEach(() => {
    test.skip(!GITHUB_AUTH, "Requires GitHub authentication (gh auth login)");
  });

  test("manual restore latches and keeps a merged pull request workspace active", async ({
    page,
  }) => {
    const scenario = await createMergedPullRequestScenario();

    try {
      await scenario.autoArchive();
      await openArchivedWorkspaceFromHistory(page, scenario.agentTitle);
      await restoreWorkspace(page, scenario.workspaceId);

      await scenario.refreshMergedPullRequest();
      await scenario.expectWorkspaceRemainsActive();
      await waitForWorkspaceInSidebar(page, {
        serverId: getServerId(),
        workspaceId: scenario.workspaceId,
      });
    } finally {
      await scenario.cleanup();
    }
  });
});

interface MergedPullRequestScenario {
  agentTitle: string;
  workspaceId: string;
  autoArchive(): Promise<void>;
  refreshMergedPullRequest(): Promise<void>;
  expectWorkspaceRemainsActive(): Promise<void>;
  cleanup(): Promise<void>;
}

async function createMergedPullRequestScenario(): Promise<MergedPullRequestScenario> {
  const repo = await createTempGithubRepo({
    category: "auto-archive-latch",
    prs: [{ title: "Auto-archive latch", state: "merged" }],
  });
  const checkout = await cloneGithubRepoDefaultBranchOnly(repo);
  const workspaceClient = await connectNewWorkspaceDaemonClient();
  const agentClient = await connectSeedClient();
  const previousConfig = await workspaceClient.getDaemonConfig();
  let workspaceDirectory: string | undefined;
  let projectId: string | undefined;
  await workspaceClient.patchDaemonConfig({ autoArchiveAfterMerge: false });

  try {
    const pullRequest = repo.prs[0];
    if (!pullRequest) {
      throw new Error("Expected the merged pull request fixture");
    }
    const created = await workspaceClient.createPaseoWorktree({
      cwd: checkout.path,
      action: "checkout",
      checkoutSource: {
        kind: "change_request",
        forge: "github",
        number: pullRequest.number,
      },
      worktreeSlug: `auto-archive-latch-${Date.now()}`,
    });
    if (!created.workspace || created.error) {
      throw new Error(created.error ?? "Failed to create merged pull request workspace");
    }

    const workspace = created.workspace;
    workspaceDirectory = workspace.workspaceDirectory;
    projectId = workspace.projectId;
    const agentTitle = `Auto-archive latch ${Date.now()}`;
    const agent = await agentClient.createAgent({
      provider: "mock",
      model: "ten-second-stream",
      modeId: "load-test",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.id,
      title: agentTitle,
    });
    await agentClient.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );

    return {
      agentTitle,
      workspaceId: workspace.id,
      autoArchive: async () => {
        await workspaceClient.patchDaemonConfig({ autoArchiveAfterMerge: true });
        await workspaceClient.checkoutRefresh(workspace.workspaceDirectory);
        await expect
          .poll(() => agentClient.fetchAgent({ agentId: agent.id }), { timeout: 30_000 })
          .toMatchObject({ agent: { archivedAt: expect.any(String) } });
        await expect
          .poll(() => existsSync(workspace.workspaceDirectory), { timeout: 30_000 })
          .toBe(false);
      },
      refreshMergedPullRequest: async () => {
        const refresh = await workspaceClient.checkoutRefresh(workspace.workspaceDirectory);
        if (!refresh.success) {
          throw new Error(`Failed to refresh restored workspace: ${String(refresh.error)}`);
        }
      },
      expectWorkspaceRemainsActive: async () => {
        const observationDeadline = Date.now() + 5_000;
        await expect
          .poll(
            async () => {
              const descriptor = (await workspaceClient.fetchWorkspaces()).entries.find(
                (entry) => entry.id === workspace.id,
              );
              if (!descriptor) {
                return "archived";
              }
              return Date.now() >= observationDeadline ? "active" : "observing";
            },
            { timeout: 10_000, intervals: [100, 250, 500] },
          )
          .toBe("active");
      },
      cleanup: async () => {
        await workspaceClient
          .patchDaemonConfig({
            autoArchiveAfterMerge: previousConfig.config.autoArchiveAfterMerge,
          })
          .catch(() => undefined);
        await archiveWorkspaceFromDaemon(workspaceClient, workspace.workspaceDirectory).catch(
          () => undefined,
        );
        await workspaceClient.removeProject(workspace.projectId).catch(() => undefined);
        await agentClient.close().catch(() => undefined);
        await workspaceClient.close().catch(() => undefined);
        await checkout.cleanup().catch(() => undefined);
        await repo.cleanup().catch(() => undefined);
      },
    };
  } catch (error) {
    await cleanupFailedScenario({
      repo,
      checkout,
      workspaceClient,
      agentClient,
      autoArchiveAfterMerge: previousConfig.config.autoArchiveAfterMerge,
      workspaceDirectory,
      projectId,
    });
    throw error;
  }
}

async function cleanupFailedScenario(input: {
  repo: GhRepoFixture;
  checkout: GhDefaultBranchClone;
  workspaceClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  agentClient: Awaited<ReturnType<typeof connectSeedClient>>;
  autoArchiveAfterMerge: boolean;
  workspaceDirectory?: string;
  projectId?: string;
}): Promise<void> {
  await input.workspaceClient
    .patchDaemonConfig({ autoArchiveAfterMerge: input.autoArchiveAfterMerge })
    .catch(() => undefined);
  if (input.workspaceDirectory) {
    await archiveWorkspaceFromDaemon(input.workspaceClient, input.workspaceDirectory).catch(
      () => undefined,
    );
  }
  if (input.projectId) {
    await input.workspaceClient.removeProject(input.projectId).catch(() => undefined);
  }
  await input.agentClient.close().catch(() => undefined);
  await input.workspaceClient.close().catch(() => undefined);
  await input.checkout.cleanup().catch(() => undefined);
  await input.repo.cleanup().catch(() => undefined);
}

async function openArchivedWorkspaceFromHistory(page: Page, agentTitle: string): Promise<void> {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await openSessions(page);
  await expectSessionRowArchived(page, agentTitle);
  await clickSessionRow(page, agentTitle);
  await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function restoreWorkspace(page: Page, workspaceId: string): Promise<void> {
  const action = page.getByTestId("workspace-recovery-action");
  await expect(action).toHaveText("Restore");
  await action.click();
  await waitForWorkspaceInSidebar(page, { serverId: getServerId(), workspaceId });
}
