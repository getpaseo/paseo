import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import type {
  AgentManager,
  ImportableSessionProviderError,
  ManagedImportableProviderSession,
} from "./agent/agent-manager.js";
import { listProjectSuggestions } from "./project-suggestions.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import type { PersistedProjectRecord } from "./workspace-registry.js";

const NOW = new Date("2026-10-31T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  return repo;
}

function session(
  provider: string,
  cwd: string,
  lastActivityAt: Date,
): ManagedImportableProviderSession {
  return {
    provider,
    providerHandleId: `${provider}-${cwd}-${lastActivityAt.toISOString()}`,
    cwd,
    title: null,
    firstPromptPreview: "Fix the build",
    lastPromptPreview: null,
    lastActivityAt,
  };
}

/** Agent history as the providers report it. */
function agentHistory(
  sessions: ManagedImportableProviderSession[],
  providerErrors: ImportableSessionProviderError[] = [],
): Pick<AgentManager, "listImportableSessions"> {
  return {
    listImportableSessions: async (options) => ({
      sessions: sessions.filter(
        (entry) => !options?.providerFilter || options.providerFilter.has(entry.provider),
      ),
      providerErrors,
    }),
  };
}

function projects(...rootPaths: Array<{ rootPath: string; archived?: boolean }>) {
  const records = rootPaths.map(
    ({ rootPath, archived }, index): PersistedProjectRecord => ({
      projectId: `project-${index}`,
      rootPath,
      kind: "git",
      displayName: path.basename(rootPath),
      projectKey: null,
      customName: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      archivedAt: archived ? NOW.toISOString() : null,
    }),
  );
  return { list: async () => records };
}

describe("listProjectSuggestions", () => {
  let root: string;
  let gitService: WorkspaceGitServiceImpl;

  beforeEach(() => {
    // The native realpath expands Windows short names (RUNNER~1), which git reports in full.
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "project-suggestions-")));
    gitService = new WorkspaceGitServiceImpl({
      logger: createTestLogger(),
      paseoHome: path.join(root, ".paseo"),
    });
  });

  afterEach(async () => {
    await gitService.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  test("groups sessions in a repo, its subdirectories and its worktrees under the main checkout", async () => {
    const app = createRepo(root, "app");
    mkdirSync(path.join(app, "packages", "web"), { recursive: true });
    const worktree = path.join(root, "codex-worktrees", "app-feature");
    git(app, "worktree", "add", "-b", "feature", worktree);

    const result = await listProjectSuggestions({
      request: {},
      agentManager: agentHistory([
        session("claude", app, daysAgo(1)),
        session("claude", path.join(app, "packages", "web"), daysAgo(2)),
        session("codex", worktree, daysAgo(3)),
      ]),
      projectRegistry: projects(),
      workspaceGitService: gitService,
      now: NOW,
    });

    expect(result).toEqual({
      suggestions: [
        {
          rootPath: app,
          displayName: "app",
          sessionCount: 3,
          providerIds: ["claude", "codex"],
          lastActivityAt: daysAgo(1).toISOString(),
        },
      ],
      providerErrors: [],
    });
  });

  test("leaves out active projects, deleted folders, old sessions and the home directory", async () => {
    const added = createRepo(root, "already-added");
    const removed = createRepo(root, "removed-project");
    const notes = path.join(root, "notes");
    mkdirSync(notes);

    const result = await listProjectSuggestions({
      request: {},
      agentManager: agentHistory([
        session("claude", added, daysAgo(1)),
        session("claude", removed, daysAgo(2)),
        session("claude", notes, daysAgo(4)),
        session("claude", path.join(root, "deleted"), daysAgo(1)),
        session("claude", createRepo(root, "stale"), daysAgo(45)),
        session("claude", homedir(), daysAgo(1)),
      ]),
      projectRegistry: projects({ rootPath: added }, { rootPath: removed, archived: true }),
      workspaceGitService: gitService,
      now: NOW,
    });

    expect(result.suggestions.map((suggestion) => suggestion.rootPath)).toEqual([removed, notes]);
  });

  test("reads only the requested providers and reports the ones that failed", async () => {
    const app = createRepo(root, "app");
    const api = createRepo(root, "api");

    const result = await listProjectSuggestions({
      request: { providers: ["codex"] },
      agentManager: agentHistory(
        [session("claude", app, daysAgo(1)), session("codex", api, daysAgo(1))],
        [{ provider: "codex", message: "Timed out listing sessions" }],
      ),
      projectRegistry: projects(),
      workspaceGitService: gitService,
      now: NOW,
    });

    expect(result).toEqual({
      suggestions: [
        {
          rootPath: api,
          displayName: "api",
          sessionCount: 1,
          providerIds: ["codex"],
          lastActivityAt: daysAgo(1).toISOString(),
        },
      ],
      providerErrors: [{ provider: "codex", message: "Timed out listing sessions" }],
    });
  });
});
