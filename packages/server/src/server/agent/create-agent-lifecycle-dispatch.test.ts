import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import type { ForgeService } from "../../services/forge-service.js";
import { createWorktree } from "../../utils/worktree.js";
import { WorkspaceAutomationBlockedError } from "../workspace-automation-gate.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { AgentManager, AgentManagerEvent, AgentSubscriber } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  CreateAgentLifecycleDispatch,
  registerAgentAutoArchive,
} from "./create-agent-lifecycle-dispatch.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

class AgentLifecycleEvents {
  private readonly listeners = new Set<AgentSubscriber>();

  subscribe(listener: AgentSubscriber): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  completeTurn(agentId: string): void {
    const event: AgentManagerEvent = {
      type: "agent_stream",
      agentId,
      event: { type: "turn_completed", provider: "codex" },
    };
    for (const listener of this.listeners) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

async function createUntrustedWorktreeFixture(slug: string, markerName: string) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "lifecycle-dispatch-"));
  cleanupPaths.push(tempDir);
  const repoDir = path.join(tempDir, "repo");
  const paseoHome = path.join(tempDir, ".paseo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(
    path.join(repoDir, "paseo.json"),
    JSON.stringify({
      worktree: {
        teardown: [
          `node -e "require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/${markerName}', 'ran')"`,
        ],
      },
    }),
  );
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  const worktree = await createWorktree({
    cwd: repoDir,
    worktreeSlug: slug,
    source: { kind: "branch-off", baseBranch: "main", branchName: slug },
    paseoHome,
  });
  const workspace: PersistedWorkspaceRecord = {
    workspaceId: `ws-${slug}`,
    projectId: "proj-1",
    cwd: worktree.worktreePath,
    kind: "worktree",
    worktreeRoot: worktree.worktreePath,
    isPaseoOwnedWorktree: true,
    mainRepoRoot: repoDir,
    createdAt: "2026-11-24T00:00:00.000Z",
    updatedAt: "2026-11-24T00:00:00.000Z",
  };
  const blockedSource = {
    kind: "change_request" as const,
    forge: "github",
    number: 99,
    headRepository: "contributor/paseo",
  };
  const assertWorkspaceAutomationAllowed = vi.fn(async (id: string) => {
    if (id === workspace.workspaceId) {
      throw new WorkspaceAutomationBlockedError(blockedSource);
    }
  });
  const activeWorkspaces = [workspace];
  const archived = new Set<string>();
  const events = new AgentLifecycleEvents();
  const agentManager = {
    subscribe: (cb: AgentSubscriber) => events.subscribe(cb),
    listAgents: () => [],
    getAgent: () => null,
    archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
    archiveSnapshot: vi.fn(async () => ({})),
  } as unknown as AgentManager;
  const dispatch = new CreateAgentLifecycleDispatch({
    paseoHome,
    getWorkspace: async (id) => (id === workspace.workspaceId ? workspace : null),
    assertWorkspaceAutomationAllowed,
    isCheckoutUntrusted: async () => false,
    agentManager,
    agentStorage: { listByWorkspace: async () => [] } as unknown as AgentStorage,
    github: { invalidate: () => {} } as unknown as ForgeService,
    workspaceGitService: {
      getSnapshot: vi.fn(async () => null),
      invalidateWorktrees: () => {},
    } as unknown as WorkspaceGitService,
    createPaseoWorktreeWorkflow: vi.fn(),
    archiveAgentForClose: vi.fn(async () => undefined),
    findWorkspaceIdForCwd: async () => workspace.workspaceId,
    listActiveWorkspaces: async () => activeWorkspaces.filter((w) => !archived.has(w.workspaceId)),
    archiveWorkspaceRecord: async (id) => {
      archived.add(id);
    },
    emit: vi.fn(),
    emitAgentRemove: vi.fn(async () => undefined),
    emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => undefined),
    markWorkspaceArchiving: vi.fn(),
    clearWorkspaceArchiving: vi.fn(),
    killTerminalsForWorkspace: vi.fn(async () => undefined),
    logger: pino({ level: "silent" }),
  });

  return {
    dispatch,
    events,
    marker: path.join(repoDir, markerName),
    createdWorktree: { worktree, workspace },
    archived,
    assertWorkspaceAutomationAllowed,
  };
}

test("auto-archive self-releases once and later cancellation waits harmlessly", async () => {
  const agentId = "4a7e2521-286d-4ad5-af35-e091c55302e3";
  const agents = new AgentLifecycleEvents();
  let archiveCount = 0;
  const registration = registerAgentAutoArchive({
    agentManager: agents,
    agentId,
    archive: async () => {
      archiveCount += 1;
    },
  });

  agents.completeTurn(agentId);
  await registration.cancel();
  await registration.cancel();
  agents.completeTurn(agentId);

  expect(archiveCount).toBe(1);
  expect(agents.listenerCount()).toBe(0);
});

test("failed create cleanup skips teardown commands for an unapproved cross-repository checkout", async () => {
  const { dispatch, marker, createdWorktree, archived, assertWorkspaceAutomationAllowed } =
    await createUntrustedWorktreeFixture("failed-create-untrusted", "failed-create-teardown.log");

  await dispatch.cleanupCreatedWorktreeAfterFailedAgentCreate({
    createdWorktree,
    createdAgentId: null,
  });

  expect(assertWorkspaceAutomationAllowed).toHaveBeenCalledWith(
    createdWorktree.workspace.workspaceId,
  );
  expect(archived.has(createdWorktree.workspace.workspaceId)).toBe(true);
  expect(existsSync(createdWorktree.worktree.worktreePath)).toBe(false);
  expect(existsSync(marker)).toBe(false);
});

test("first-turn auto-archive skips teardown commands for an unapproved cross-repository checkout", async () => {
  const { dispatch, events, marker, createdWorktree, archived, assertWorkspaceAutomationAllowed } =
    await createUntrustedWorktreeFixture("auto-archive-untrusted", "auto-archive-teardown.log");
  const agentId = "agent-auto-archive-untrusted";

  const registration = dispatch.registerAutoArchiveIfRequested({
    autoArchive: true,
    agentId,
    createdWorktree,
  });
  events.completeTurn(agentId);
  await registration.cancel();

  expect(assertWorkspaceAutomationAllowed).toHaveBeenCalledWith(
    createdWorktree.workspace.workspaceId,
  );
  expect(archived.has(createdWorktree.workspace.workspaceId)).toBe(true);
  expect(existsSync(createdWorktree.worktree.worktreePath)).toBe(false);
  expect(existsSync(marker)).toBe(false);
});
