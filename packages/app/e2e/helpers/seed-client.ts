import path from "node:path";
import { readFileSync } from "node:fs";
import { connectDaemonClient } from "./daemon-client-loader";
import { createTempGitRepo } from "./workspace";

/**
 * The general-purpose E2E daemon client used to seed and drive state out of
 * band (workspaces, agents, terminals) while the UI is exercised through the
 * browser. Domain-specific helpers wrap it for their own flows; specs should
 * prefer those wrappers over reaching for this client directly.
 */
export interface SeedDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  openProject(cwd: string): Promise<{
    workspace: { id: string; name: string; projectRootPath: string } | null;
    error: string | null;
  }>;
  createTerminal(
    cwd: string,
    name?: string,
  ): Promise<{
    terminal: { id: string; name: string; cwd: string } | null;
    error: string | null;
  }>;
  createAgent(options: {
    provider: string;
    cwd: string;
    title?: string;
    modeId?: string;
    model?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
    initialPrompt?: string;
  }): Promise<{ id: string; status: string }>;
  fetchAgents(options?: { scope?: "active" }): Promise<{
    entries: Array<{ agent: { id: string; cwd: string; title?: string | null } }>;
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
 * A temp git repo opened as a workspace, with a seed client connected to drive
 * it out of band. `cleanup` closes the client and removes the repo. This is the
 * canonical bootstrap for specs that need a real workspace plus daemon access;
 * domain helpers (e.g. mock-agent) build on it rather than re-rolling the trio.
 */
export interface SeededWorkspace {
  client: SeedDaemonClient;
  repoPath: string;
  workspaceId: string;
  cleanup(): Promise<void>;
}

export async function seedWorkspace(options: {
  repoPrefix: string;
  repo?: Parameters<typeof createTempGitRepo>[1];
}): Promise<SeededWorkspace> {
  const repo = await createTempGitRepo(options.repoPrefix, options.repo);
  const client = await connectSeedClient();
  try {
    const opened = await client.openProject(repo.path);
    if (!opened.workspace) {
      throw new Error(opened.error ?? `Failed to open project ${repo.path}`);
    }
    return {
      client,
      repoPath: repo.path,
      workspaceId: opened.workspace.id,
      cleanup: async () => {
        await client.close().catch(() => undefined);
        await repo.cleanup().catch(() => undefined);
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await repo.cleanup().catch(() => undefined);
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
