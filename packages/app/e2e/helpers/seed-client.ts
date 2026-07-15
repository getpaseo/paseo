import path from "node:path";
import { readFileSync } from "node:fs";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import { connectDaemonClient } from "./daemon-client-loader";
import { createTempDirectory, createTempGitRepo } from "./workspace";

export interface SeedWorkspaceDescriptor {
  id: string;
  name: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory: string;
}

/**
 * The general-purpose E2E daemon client used to seed and drive state out of
 * band (workspaces, agents, terminals) while the UI is exercised through the
 * browser. Domain-specific helpers wrap it for their own flows; specs should
 * prefer those wrappers over reaching for this client directly.
 */
export interface SeedDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  addProject(cwd: string): Promise<{
    project: {
      projectId: string;
      projectDisplayName: string;
      projectRootPath: string;
    } | null;
    error: string | null;
  }>;
  removeProject(projectId: string): Promise<{ removedWorkspaceIds: string[] }>;
  fetchWorkspaces(options?: { filter?: { projectId?: string } }): Promise<{
    entries: SeedWorkspaceDescriptor[];
  }>;
  createWorkspace(input: {
    source:
      | { kind: "directory"; path: string; projectId?: string }
      | {
          kind: "worktree";
          cwd?: string;
          projectId?: string;
          action?: "branch-off" | "checkout";
          refName?: string;
          baseBranch?: string;
          githubPrNumber?: number;
          worktreeSlug?: string;
        };
    title?: string;
  }): Promise<{
    workspace: SeedWorkspaceDescriptor | null;
    error: string | null;
  }>;
  /**
   * Force the daemon to recompute its git snapshot and diff for a checkout,
   * mirroring the UI's manual refresh. Tests use this to make an out-of-band
   * working-tree write authoritative before asserting on it in the UI, instead
   * of racing the filesystem watcher's debounce.
   */
  checkoutRefresh(cwd: string): Promise<{ success: boolean; error: unknown }>;
  createTerminal(
    cwd: string,
    name?: string,
    requestId?: string,
    options?: { agentId?: string; command?: string; args?: string[]; workspaceId?: string },
  ): Promise<{
    terminal: { id: string; name: string; cwd: string; activity?: TerminalActivity | null } | null;
    error: string | null;
  }>;
  listTerminals(
    cwd?: string,
    requestId?: string,
    options?: { workspaceId?: string },
  ): Promise<{
    terminals: Array<{
      id: string;
      name: string;
      cwd: string;
      title?: string;
      activity?: TerminalActivity | null;
    }>;
    error?: string | null;
  }>;
  createAgent(options: {
    provider: string;
    cwd: string;
    workspaceId?: string;
    title?: string;
    modeId?: string;
    model?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
    initialPrompt?: string;
    labels?: Record<string, string>;
  }): Promise<{ id: string; status: string }>;
  fetchAgents(options?: { scope?: "active" }): Promise<{
    entries: Array<{
      agent: {
        id: string;
        provider: string;
        cwd: string;
        workspaceId?: string;
        model: string | null;
        currentModeId: string | null;
        status: string;
        title?: string | null;
      };
    }>;
  }>;
  fetchRecentProviderSessions(options: {
    cwd: string;
    providers: string[];
    limit: number;
  }): Promise<{
    entries: Array<{
      providerId: string;
      providerHandleId: string;
      cwd: string;
      firstPromptPreview?: string | null;
    }>;
  }>;
  updateAgent(agentId: string, updates: { name?: string }): Promise<void>;
  waitForAgentUpsert(
    agentId: string,
    predicate: (snapshot: { status: string }) => boolean,
    timeout?: number,
  ): Promise<{ status: string }>;
  sendAgentMessage(agentId: string, text: string): Promise<void>;
  waitForFinish(
    agentId: string,
    timeout?: number,
  ): Promise<{ status: string; final?: { lastError?: string | null } | null }>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
  fetchAgent(options: {
    agentId: string;
  }): Promise<{ agent: { id: string; archivedAt?: string | null } } | null>;
  getLastServerInfoMessage(): {
    features?: { projectAdd?: boolean; worktreeRestore?: boolean } | null;
  } | null;
  fetchAgentHistory(options?: {
    page?: { limit: number };
  }): Promise<{ entries: Array<{ id: string }> }>;
  subscribeTerminal(
    terminalId: string,
  ): Promise<{ terminalId: string; slot: number; error: null } | { error: string }>;
  sendTerminalInput(
    terminalId: string,
    message: { type: "input"; data: string } | { type: "resize"; rows: number; cols: number },
  ): void;
  onTerminalStreamEvent(
    handler: (event: { terminalId: string; type: string; data?: Uint8Array }) => void,
  ): () => void;
  killTerminal(terminalId: string): Promise<{ error: string | null }>;
}

export async function connectSeedClient(): Promise<SeedDaemonClient> {
  return connectDaemonClient<SeedDaemonClient>({
    clientIdPrefix: "seed",
    appVersion: loadAppVersion(),
  });
}

/**
 * A temp project opened as a workspace, with a seed client connected to drive
 * it out of band. `cleanup` closes the client and removes the project. This is
 * the canonical bootstrap for specs that need a real workspace plus daemon
 * access; domain helpers (e.g. mock-agent) build on it rather than re-rolling
 * the trio. `repoPath` is the project root on disk (git repo or plain dir).
 */
export interface SeededWorkspace {
  client: SeedDaemonClient;
  repoPath: string;
  workspaceId: string;
  workspaceName: string;
  workspaceDirectory: string;
  /** Stable project identity the daemon groups workspaces under. */
  projectId: string;
  /** Project label the UI shows (owner/repo for known remotes, else basename). */
  projectDisplayName: string;
  cleanup(): Promise<void>;
}

export async function seedWorkspace(options: {
  repoPrefix: string;
  title?: string;
  /** Repo fixture options; only applies to git projects (the default). */
  repo?: Parameters<typeof createTempGitRepo>[1];
  /** Set to false to seed a plain non-git directory instead of a git repo. */
  git?: boolean;
}): Promise<SeededWorkspace> {
  const project =
    options.git === false
      ? await createTempDirectory(options.repoPrefix)
      : await createTempGitRepo(options.repoPrefix, options.repo);
  const client = await connectSeedClient();
  try {
    const created = await client.createWorkspace({
      source: { kind: "directory", path: project.path },
      title: options.title,
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${project.path}`);
    }
    const workspace = created.workspace;
    return {
      client,
      repoPath: project.path,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceDirectory: workspace.workspaceDirectory,
      projectId: workspace.projectId,
      projectDisplayName: workspace.projectDisplayName,
      cleanup: async () => {
        await client.removeProject(workspace.projectId).catch(() => undefined);
        await client.close().catch(() => undefined);
        await project.cleanup().catch(() => undefined);
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await project.cleanup().catch(() => undefined);
    throw error;
  }
}

function loadAppVersion(): string {
  const packageJsonPath = path.resolve(__dirname, "../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`Missing app version in ${packageJsonPath}`);
  }
  return packageJson.version;
}
