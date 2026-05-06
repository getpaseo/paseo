import { execSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { waitForTabBar } from "./launcher";
import { selectWorkspaceInSidebar } from "./sidebar";
import { createTempGitRepo } from "./workspace";
import {
  connectWorkspaceSetupClient,
  openHomeWithProject,
  type WorkspaceSetupDaemonClient,
} from "./workspace-setup";

export interface CreatedWorkspace {
  workspaceId: string;
  repoPath: string;
  navigateTo(): Promise<void>;
}

export interface WithWorkspaceOptions {
  worktree?: boolean;
  prefix?: string;
}

export type WithWorkspace = (options?: WithWorkspaceOptions) => Promise<CreatedWorkspace>;

interface WorktreeRecord {
  repoPath: string;
  worktreePath: string;
}

export interface WithWorkspaceHandle {
  withWorkspace: WithWorkspace;
  cleanup: () => Promise<void>;
}

export function createWithWorkspace(page: Page): WithWorkspaceHandle {
  let client: WorkspaceSetupDaemonClient | null = null;
  const repos: Array<{ cleanup: () => Promise<void> }> = [];
  const worktrees: WorktreeRecord[] = [];

  const withWorkspace: WithWorkspace = async (options) => {
    if (!client) {
      client = await connectWorkspaceSetupClient();
    }
    const prefix = options?.prefix ?? (options?.worktree ? "wt-" : "ws-");
    const repo = await createTempGitRepo(prefix);
    repos.push(repo);

    let workspacePath = repo.path;
    if (options?.worktree) {
      const tempRoot = await realpath("/tmp");
      workspacePath = path.join(
        tempRoot,
        `paseo-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const branchName = `paseo-wt-${Date.now()}`;
      execSync(
        `git worktree add ${JSON.stringify(workspacePath)} -b ${JSON.stringify(branchName)} main`,
        { cwd: repo.path, stdio: "ignore" },
      );
      worktrees.push({ repoPath: repo.path, worktreePath: workspacePath });
      // Register the parent project so the sidebar lists it before we navigate.
      await client.openProject(repo.path);
    }

    const opened = await client.openProject(workspacePath);
    if (!opened.workspace) {
      throw new Error(opened.error ?? `Failed to open project ${workspacePath}`);
    }
    const workspaceId = opened.workspace.id;

    return {
      workspaceId,
      repoPath: workspacePath,
      navigateTo: async () => {
        await openHomeWithProject(page, repo.path);
        await selectWorkspaceInSidebar(page, workspaceId);
        await waitForTabBar(page);
      },
    };
  };

  return {
    withWorkspace,
    cleanup: async () => {
      for (const { repoPath, worktreePath } of worktrees) {
        try {
          execSync(`git worktree remove ${JSON.stringify(worktreePath)} --force`, {
            cwd: repoPath,
            stdio: "ignore",
          });
        } catch {
          // Best-effort cleanup so the original test failure is preserved.
        }
      }
      for (const repo of repos) {
        await repo.cleanup();
      }
      if (client) {
        await client.close().catch(() => undefined);
      }
    },
  };
}
