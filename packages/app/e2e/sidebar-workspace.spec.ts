import { execSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  closeMobileAgentSidebar,
  expectMobileAgentSidebarHidden,
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "./helpers/sidebar";
import { createTempGitRepo } from "./helpers/workspace";
import { expectWorkspaceHeader } from "./helpers/workspace-ui";
import { connectWorkspaceSetupClient } from "./helpers/workspace-setup";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}

function getWorkspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setGitHubRemote(repoPath: string): void {
  execSync("git remote set-url origin https://github.com/test-owner/test-repo.git", {
    cwd: repoPath,
    stdio: "ignore",
  });
}

async function createTempDirectory(prefix = "paseo-e2e-dir-") {
  const tempRoot = process.platform === "win32" ? tmpdir() : await realpath("/tmp");
  const dirPath = await mkdtemp(path.join(tempRoot, prefix));
  await writeFile(path.join(dirPath, "README.md"), "# Temp Directory\n");
  return {
    path: dirPath,
    cleanup: async () => {
      await rm(dirPath, { recursive: true, force: true });
    },
  };
}

async function openProjectViaDaemon(
  client: Awaited<ReturnType<typeof connectWorkspaceSetupClient>>,
  cwd: string,
): Promise<{ id: string; name: string }> {
  const result = await client.openProject(cwd);
  if (!result.workspace || result.error) {
    throw new Error(result.error ?? `Failed to open project ${cwd}`);
  }
  return {
    id: result.workspace.id,
    name: result.workspace.name,
  };
}

async function openWorkspaceFromSidebar(
  page: import("@playwright/test").Page,
  workspaceId: string,
) {
  const row = page.getByTestId(getWorkspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
  return row;
}

async function waitForSidebarProject(page: import("@playwright/test").Page, projectName: string) {
  const row = page
    .getByRole("button", {
      name: new RegExp(escapeRegex(projectName), "i"),
    })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function waitForSidebarWorkspace(page: import("@playwright/test").Page, workspaceId: string) {
  const row = page.getByTestId(getWorkspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

test.describe("Sidebar workspace list", () => {
  test("project with GitHub remote shows owner/repo name in sidebar", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("sidebar-remote-", { withRemote: true });

    try {
      setGitHubRemote(repo.path);
      const workspace = await openProjectViaDaemon(client, repo.path);
      await gotoAppShell(page);
      await waitForSidebarProject(page, "test-owner/test-repo");
      await waitForSidebarWorkspace(page, workspace.id);

      const projectRow = page
        .locator('[data-testid^="sidebar-project-row-"]')
        .filter({ hasText: "test-owner/test-repo" })
        .first();

      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(projectRow).not.toContainText(path.basename(repo.path));
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("project shows workspace under it", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("sidebar-workspace-under-project-");

    try {
      const workspace = await openProjectViaDaemon(client, repo.path);
      await gotoAppShell(page);

      await waitForSidebarProject(page, path.basename(repo.path));
      await waitForSidebarWorkspace(page, workspace.id);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("non-git project shows directory name", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const project = await createTempDirectory("sidebar-directory-");

    try {
      await openProjectViaDaemon(client, project.path);
      await gotoAppShell(page);

      const projectRow = await waitForSidebarProject(page, path.basename(project.path));
      await expect(projectRow).toContainText(path.basename(project.path));
    } finally {
      await client.close();
      await project.cleanup();
    }
  });

  test("workspace header shows correct title and subtitle", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("sidebar-header-", { withRemote: true });

    try {
      setGitHubRemote(repo.path);
      const workspace = await openProjectViaDaemon(client, repo.path);
      await gotoAppShell(page);
      await waitForSidebarProject(page, "test-owner/test-repo");
      await waitForSidebarWorkspace(page, workspace.id);
      await openWorkspaceFromSidebar(page, workspace.id);

      await expectWorkspaceHeader(page, {
        title: workspace.name,
        subtitle: "test-owner/test-repo",
      });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("git project shows branch name in workspace row", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("sidebar-branch-");

    try {
      const workspace = await openProjectViaDaemon(client, repo.path);
      await gotoAppShell(page);
      await waitForSidebarProject(page, path.basename(repo.path));

      expect(workspace.name).toBe("main");
      await expect(await waitForSidebarWorkspace(page, workspace.id)).toContainText("main");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});

test.describe("Mobile sidebar panelState transition", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("showMobileAgent open and close transition", async ({ page }) => {
    await gotoAppShell(page);
    await expectMobileAgentSidebarHidden(page);
    await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);
    await closeMobileAgentSidebar(page);
    await expectMobileAgentSidebarHidden(page);
  });
});
