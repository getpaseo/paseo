import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  expectWorkspaceBranch,
  openChangesPanel,
  switchBranchFromChangesPanel,
} from "./helpers/branch-switcher";
import {
  createIdleAgent,
  expectSessionRowNotArchived,
  fetchAgentArchivedAt,
  openSessions,
} from "./helpers/archive-tab";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { connectSeedClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForSidebarHydration, waitForWorkspaceInSidebar } from "./helpers/workspace-ui";

test.describe("Worktree restore", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let worktreeClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();
  const createdProjectIds = new Set<string>();

  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectSeedClient();
    worktreeClient = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-restore-");
  });

  async function createArchivedMissingWorktree(prefix: string) {
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `${prefix}-${randomUUID().slice(0, 8)}`,
    });
    createdProjectIds.add(worktree.projectKey);
    createdWorktreeDirectories.add(worktree.workspaceDirectory);
    const agent = await createIdleAgent(client, {
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      title: `${prefix}-${randomUUID().slice(0, 8)}`,
    });

    await archiveWorkspaceFromDaemon(worktreeClient, worktree.workspaceDirectory);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    // Match the remote cloud-race record: workspace archived and absent, while
    // the surviving closed agent record is not agent-archived. Refresh now owns
    // only agent lifecycle, so its expected cwd failure cannot recover the workspace.
    await client.refreshAgent(agent.id).catch(() => undefined);
    await expect.poll(() => fetchAgentArchivedAt(client, agent.id), { timeout: 30_000 }).toBeNull();
    expect(existsSync(worktree.workspaceDirectory)).toBe(false);

    return { agent, worktree };
  }

  async function openArchivedWorkspaceFromHistory(page: Page, prefix: string) {
    const seeded = await createArchivedMissingWorktree(prefix);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openSessions(page);
    await expectSessionRowNotArchived(page, seeded.agent.title);
    await page.getByTestId(`agent-row-${getServerId()}-${seeded.agent.id}`).click();
    await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("workspace-recovery-action")).toHaveText("Restore");
    return seeded;
  }

  async function openArchivedAgentBeforeWorkspaceHydration(page: Page, prefix: string) {
    const seeded = await createArchivedMissingWorktree(prefix);
    const workspaceRoute = buildHostWorkspaceRoute(getServerId(), seeded.worktree.workspaceId);
    const openAgent = encodeURIComponent(`agent:${seeded.agent.id}`);

    await page.goto(`${workspaceRoute}?open=${openAgent}`);
    await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("workspace-recovery-action")).toHaveText("Restore");
    return seeded;
  }

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(worktreeClient, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    for (const projectId of createdProjectIds) {
      await worktreeClient.removeProject(projectId).catch(() => undefined);
    }
    createdProjectIds.clear();
    await client?.close().catch(() => undefined);
    await worktreeClient?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  test("opening an active History agent navigates without restoring or unarchiving", async ({
    page,
  }) => {
    const serverId = getServerId();
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `restore-inplace-${randomUUID().slice(0, 8)}`,
    });
    createdProjectIds.add(worktree.projectKey);
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const agent = await createIdleAgent(client, {
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      title: `restore-inplace-${randomUUID().slice(0, 8)}`,
    });
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openSessions(page);
    await expectSessionRowNotArchived(page, agent.title);

    await page.getByTestId(`agent-row-${serverId}-${agent.id}`).click();

    await expect(
      page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Unarchive" })).toHaveCount(0);
    expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    await openSessions(page);
    await expectSessionRowNotArchived(page, agent.title);
    await page.getByTestId(`agent-row-${serverId}-${agent.id}`).click();

    await expect(
      page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId(`workspace-deck-entry-${serverId}:${worktree.workspaceId}`),
    ).toHaveCount(1);
    expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();
  });

  test("opening a recoverable archived workspace shows an explicit Restore action without mutating it", async ({
    page,
  }) => {
    const { agent, worktree } = await openArchivedWorkspaceFromHistory(page, "restore-ready");
    expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();
    expect(existsSync(worktree.workspaceDirectory)).toBe(false);
    await expect(
      worktreeClient.inspectWorkspaceRecovery(worktree.workspaceId),
    ).resolves.toMatchObject({ kind: "recoverable", action: "restore" });
  });

  test("explicit Restore shows loading and opens the recreated workspace", async ({ page }) => {
    const { agent, worktree } = await openArchivedAgentBeforeWorkspaceHydration(
      page,
      "restore-success",
    );
    await worktreeClient.fetchWorkspaces({
      subscribe: { subscriptionId: `restore-secondary-${randomUUID()}` },
    });
    let updateTimeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeSecondaryWorkspaceUpdate = () => {};
    const secondaryWorkspaceUpdate = new Promise<void>((resolve, reject) => {
      updateTimeout = setTimeout(
        () => reject(new Error("Secondary client did not receive the restored workspace")),
        30_000,
      );
      unsubscribeSecondaryWorkspaceUpdate = worktreeClient.on("workspace_update", (message) => {
        if (
          message.payload.kind === "upsert" &&
          message.payload.workspace.id === worktree.workspaceId
        ) {
          resolve();
        }
      });
    });

    try {
      await page.getByTestId("workspace-recovery-action").click();

      await expect(page.getByText("Restoring workspace", { exact: true })).toBeVisible();
      await expect
        .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
        .toBe(true);
      await secondaryWorkspaceUpdate;
      await waitForWorkspaceInSidebar(page, {
        serverId: getServerId(),
        workspaceId: worktree.workspaceId,
      });
      await expect(
        page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("workspace-recovery-action")).toHaveCount(0);
      expect(await fetchAgentArchivedAt(client, agent.id)).toBeNull();
    } finally {
      unsubscribeSecondaryWorkspaceUpdate();
      if (updateTimeout) {
        clearTimeout(updateTimeout);
      }
    }

    const switchedBranch = `restored-live-${randomUUID().slice(0, 8)}`;
    execFileSync("git", ["branch", switchedBranch], {
      cwd: tempRepo.path,
      stdio: "pipe",
    });
    await openChangesPanel(page);
    await expectWorkspaceBranch(page, worktree.workspaceName);
    await switchBranchFromChangesPanel(page, {
      from: worktree.workspaceName,
      to: switchedBranch,
    });
    await expectWorkspaceBranch(page, switchedBranch);
    await expect(
      page.getByTestId("workspace-header-title").filter({ visible: true }).first(),
    ).toHaveText(switchedBranch, { timeout: 30_000 });
  });

  test("restore failure stays visible and permits a successful retry", async ({ page }) => {
    const { agent, worktree } = await openArchivedWorkspaceFromHistory(page, "restore-retry");
    const displacedProjectPath = `${tempRepo.path}-temporarily-unavailable`;
    await rename(tempRepo.path, displacedProjectPath);

    try {
      await page.getByTestId("workspace-recovery-action").click();
      await expect(page.getByTestId("workspace-recovery-error")).toHaveText(
        "The source repository needed to restore this worktree no longer exists.",
      );
      await expect(page.getByTestId("workspace-recovery-action")).toHaveText("Retry");
      expect(existsSync(worktree.workspaceDirectory)).toBe(false);
    } finally {
      await rename(displacedProjectPath, tempRepo.path);
    }

    await page.getByTestId("workspace-recovery-action").click();
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(true);
    await waitForWorkspaceInSidebar(page, {
      serverId: getServerId(),
      workspaceId: worktree.workspaceId,
    });
    await expect(
      page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("an unrecoverable missing workspace shows no misleading recovery action", async ({
    page,
  }) => {
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const agent = await createIdleAgent(client, {
      cwd: project.workspaceDirectory,
      workspaceId: project.workspaceId,
      title: `unrecoverable-${randomUUID().slice(0, 8)}`,
    });
    await archiveLocalWorkspaceFromDaemon(worktreeClient, project.workspaceId);
    await client.refreshAgent(agent.id).catch(() => undefined);
    await expect.poll(() => fetchAgentArchivedAt(client, agent.id), { timeout: 30_000 }).toBeNull();

    const displacedProjectPath = `${tempRepo.path}-missing`;
    await rename(tempRepo.path, displacedProjectPath);
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openSessions(page);
      await expectSessionRowNotArchived(page, agent.title);
      await page.getByTestId(`agent-row-${getServerId()}-${agent.id}`).click();

      await expect(page.getByText("Workspace unavailable", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByText(
          "The archived workspace directory no longer exists and cannot be recreated.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByTestId("workspace-recovery-action")).toHaveCount(0);
    } finally {
      await rename(displacedProjectPath, tempRepo.path);
    }
  });
});
