import { existsSync } from "node:fs";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  clickSessionRow,
  expectSessionRowArchived,
  openSessions,
} from "../support/helpers/archive-tab";
import {
  cloneGithubRepoDefaultBranchOnly,
  createTempGithubRepo,
} from "../support/helpers/github-fixtures";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
} from "../support/helpers/new-workspace";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

test.describe("Auto-archive after pull request merge", () => {
  test.describe.configure({ retries: 0, timeout: 180_000 });

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
  const cleanups: Array<() => Promise<unknown>> = [];

  try {
    const repo = await createTempGithubRepo({
      category: "auto-archive-latch",
      prs: [{ title: "Auto-archive latch", state: "merged" }],
    });
    cleanups.push(() => repo.cleanup());
    const checkout = await cloneGithubRepoDefaultBranchOnly(repo);
    cleanups.push(() => checkout.cleanup());
    const workspaceClient = await connectNewWorkspaceDaemonClient();
    cleanups.push(() => workspaceClient.close());
    const agentClient = await connectSeedClient();
    cleanups.push(() => agentClient.close());
    const previousConfig = await workspaceClient.getDaemonConfig();
    await workspaceClient.patchDaemonConfig({ autoArchiveAfterMerge: false });
    cleanups.push(() =>
      workspaceClient.patchDaemonConfig({
        autoArchiveAfterMerge: previousConfig.config.autoArchiveAfterMerge,
      }),
    );

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
    cleanups.push(() => workspaceClient.removeProject(workspace.projectId));
    cleanups.push(() => archiveWorkspaceFromDaemon(workspaceClient, workspace.workspaceDirectory));
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
      cleanup: () => runScenarioCleanups(cleanups),
    };
  } catch (error) {
    await runScenarioCleanups(cleanups);
    throw error;
  }
}

async function runScenarioCleanups(cleanups: Array<() => Promise<unknown>>): Promise<void> {
  while (cleanups.length > 0) {
    await cleanups
      .pop()?.()
      .catch(() => undefined);
  }
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
