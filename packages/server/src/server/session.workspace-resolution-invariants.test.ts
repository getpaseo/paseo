// Invariant tests for cwd → workspace resolution on the open_project_request path.
// Each test encodes a default behavior we want from `findOrCreateWorkspaceForDirectory`.
// Run to see which invariants the current code already satisfies (green) and which
// it violates (red).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import { Session, type SessionOptions } from "./session.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";

interface Harness {
  session: Session;
  emitted: SessionOutboundMessage[];
  workspaces: Map<string, PersistedWorkspaceRecord>;
  projects: Map<string, PersistedProjectRecord>;
}

function createHarness(input: {
  workspaces?: PersistedWorkspaceRecord[];
  projects?: PersistedProjectRecord[];
  gitRoots?: string[];
}): Harness {
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const projects = new Map<string, PersistedProjectRecord>();
  for (const w of input.workspaces ?? []) workspaces.set(w.workspaceId, w);
  for (const p of input.projects ?? []) projects.set(p.projectId, p);
  const gitRoots = [...(input.gitRoots ?? [])];

  function findGitRoot(cwd: string): string | null {
    let best: string | null = null;
    for (const root of gitRoots) {
      if (cwd === root || cwd.startsWith(`${root}${path.sep}`)) {
        if (!best || root.length > best.length) best = root;
      }
    }
    return best;
  }

  const workspaceGitService = createNoopWorkspaceGitService({
    getCheckout: async (cwd: string) => {
      const root = findGitRoot(cwd);
      if (!root) {
        return {
          cwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        };
      }
      return {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: root,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      };
    },
    peekSnapshot: () => null,
  });

  const emitted: SessionOutboundMessage[] = [];
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const session = new Session({
    clientId: "test",
    scopes: ["*"],
    appVersion: null,
    onMessage: (m) => emitted.push(m),
    logger: createStub<SessionOptions["logger"]>(logger),
    downloadTokenStore: createStub<SessionOptions["downloadTokenStore"]>({}),
    pushTokenStore: createStub<SessionOptions["pushTokenStore"]>({}),
    paseoHome: mkdtempSync(path.join(tmpdir(), "paseo-invariant-test-")),
    agentManager: createStub<SessionOptions["agentManager"]>({
      subscribe: () => () => {},
      listAgents: () => [],
      getAgent: () => null,
      archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
      archiveSnapshot: async () => ({}),
      clearAgentAttention: async () => {},
      notifyAgentState: () => {},
    }),
    agentStorage: createStub<SessionOptions["agentStorage"]>({
      list: async () => [],
      get: async () => null,
    }),
    projectRegistry: createStub<SessionOptions["projectRegistry"]>({
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(projects.values()),
      get: async (id: string) => projects.get(id) ?? null,
      getOrCreateActiveByRoot: async (allocation) => {
        const existing = Array.from(projects.values()).find(
          (project) => !project.archivedAt && project.rootPath === allocation.rootPath,
        );
        if (existing) return existing;
        const project = createPersistedProjectRecord({
          projectId: `prj_${projects.size.toString().padStart(16, "0")}`,
          rootPath: allocation.rootPath,
          kind: allocation.kind,
          displayName: allocation.displayName,
          createdAt: allocation.timestamp,
          updatedAt: allocation.timestamp,
        });
        projects.set(project.projectId, project);
        return project;
      },
      upsert: async (record: PersistedProjectRecord) => {
        projects.set(record.projectId, record);
      },
      archive: async (id: string, archivedAt: string) => {
        const p = projects.get(id);
        if (p) projects.set(id, { ...p, archivedAt });
      },
      remove: async (id: string) => {
        projects.delete(id);
      },
    }),
    workspaceRegistry: createStub<SessionOptions["workspaceRegistry"]>({
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(workspaces.values()),
      get: async (id: string) => workspaces.get(id) ?? null,
      upsert: async (record: PersistedWorkspaceRecord) => {
        workspaces.set(record.workspaceId, record);
      },
      archive: async (id: string, archivedAt: string) => {
        const w = workspaces.get(id);
        if (w) workspaces.set(id, { ...w, archivedAt });
      },
      remove: async (id: string) => {
        workspaces.delete(id);
      },
    }),
    filesystem: { isDirectory: async () => true },
    chatService: createStub<SessionOptions["chatService"]>({}),
    scheduleService: createStub<SessionOptions["scheduleService"]>({}),
    loopService: createStub<SessionOptions["loopService"]>({}),
    checkoutDiffManager: createStub<SessionOptions["checkoutDiffManager"]>({
      subscribe: async () => ({
        initial: { cwd: "/tmp", files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      onWorkspaceStateMayHaveChanged: () => {},
      invalidateForge: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    }),
    workspaceGitService,
    daemonConfigStore: createStub<SessionOptions["daemonConfigStore"]>({
      get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
      onChange: () => () => {},
    }),
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: null,
  });

  return { session, emitted, workspaces, projects };
}

async function openProject(session: Session, cwd: string, requestId = "req-1") {
  await asInternals<{ handleMessage(m: unknown): Promise<unknown> }>(session).handleMessage({
    type: "open_project_request",
    cwd,
    requestId,
  });
}

function getOpenResponse(emitted: SessionOutboundMessage[], requestId: string) {
  const m = emitted.find(
    (msg) => msg.type === "open_project_response" && msg.payload.requestId === requestId,
  );
  if (!m || m.type !== "open_project_response") return null;
  return m.payload;
}

const T0 = "2026-01-01T00:00:00.000Z";
const FOO = path.resolve("/foo");
const FOO_SUB = path.join(FOO, "sub");
const BAR = path.resolve("/bar");
const BAR_BAZ = path.join(BAR, "baz");
const TOOLBOX = path.resolve("/toolbox");
const TOOLBOX_FLOMO = path.join(TOOLBOX, "flomo-cli");
const USERS_DEVELOPER = path.resolve("/Users/me/Developer");
const USERS_PROJECT = path.join(USERS_DEVELOPER, "projects", "foo");
const PROJECTS = path.resolve("/projects");
const SOME_GIT_REPO = path.join(PROJECTS, "some-git-repo");
const PARENT = path.resolve("/parent");
const PARENT_CHILD = path.join(PARENT, "child");

function gitWorkspace(rootPath: string, archivedAt: string | null = null) {
  return createPersistedWorkspaceRecord({
    workspaceId: `ws-${path.basename(rootPath) || "root"}`,
    projectId: rootPath,
    cwd: rootPath,
    kind: "local_checkout",
    displayName: "main",
    createdAt: T0,
    updatedAt: T0,
    archivedAt,
  });
}

function dirWorkspace(cwd: string, archivedAt: string | null = null) {
  return createPersistedWorkspaceRecord({
    workspaceId: `ws-${path.basename(cwd) || "root"}`,
    projectId: cwd,
    cwd,
    kind: "directory",
    displayName: path.basename(cwd),
    createdAt: T0,
    updatedAt: T0,
    archivedAt,
  });
}

function gitProject(rootPath: string, archivedAt: string | null = null) {
  return createPersistedProjectRecord({
    projectId: rootPath,
    rootPath,
    kind: "git",
    displayName: path.basename(rootPath),
    createdAt: T0,
    updatedAt: T0,
    archivedAt,
  });
}

function dirProject(rootPath: string, archivedAt: string | null = null) {
  return createPersistedProjectRecord({
    projectId: rootPath,
    rootPath,
    kind: "non_git",
    displayName: path.basename(rootPath),
    createdAt: T0,
    updatedAt: T0,
    archivedAt,
  });
}

function workspaceByCwd(
  workspaces: Map<string, PersistedWorkspaceRecord>,
  cwd: string,
): PersistedWorkspaceRecord | null {
  return Array.from(workspaces.values()).find((workspace) => workspace.cwd === cwd) ?? null;
}

function hasWorkspaceCwd(workspaces: Map<string, PersistedWorkspaceRecord>, cwd: string): boolean {
  return workspaceByCwd(workspaces, cwd) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// S1. Open a fresh git repo: creates a workspace at the canonical root.
// ─────────────────────────────────────────────────────────────────────────────
test("S1: open fresh git repo creates workspace at canonical root", async () => {
  const h = createHarness({ gitRoots: [FOO] });
  await openProject(h.session, FOO);
  const resp = getOpenResponse(h.emitted, "req-1");
  expect(resp?.error).toBeNull();
  expect(resp?.workspace?.workspaceDirectory).toBe(FOO);
  expect(resp?.workspace?.workspaceKind).toBe("local_checkout");
  expect(hasWorkspaceCwd(h.workspaces, FOO)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// S2. Open a fresh non-git directory: creates a directory workspace.
//     (Capability we are explicitly keeping.)
// ─────────────────────────────────────────────────────────────────────────────
test("S2: open fresh non-git directory creates a directory workspace at exact path", async () => {
  const h = createHarness({});
  await openProject(h.session, BAR);
  const resp = getOpenResponse(h.emitted, "req-1");
  expect(resp?.error).toBeNull();
  expect(resp?.workspace?.workspaceDirectory).toBe(BAR);
  expect(resp?.workspace?.workspaceKind).toBe("directory");
  expect(hasWorkspaceCwd(h.workspaces, BAR)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// S3. Re-open an active workspace by its exact path: returns the same record,
//     no archive state change.
// ─────────────────────────────────────────────────────────────────────────────
test("S3: re-open active workspace by exact path returns the same record", async () => {
  const h = createHarness({
    workspaces: [gitWorkspace(FOO)],
    projects: [gitProject(FOO)],
    gitRoots: [FOO],
  });
  await openProject(h.session, FOO);
  const resp = getOpenResponse(h.emitted, "req-1");
  expect(resp?.workspace?.id).toBe(workspaceByCwd(h.workspaces, FOO)?.workspaceId);
  expect(h.workspaces.size).toBe(1);
  expect(workspaceByCwd(h.workspaces, FOO)?.archivedAt).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// S4. Every selected path is an exact lexical root, even inside a Git checkout.
// ─────────────────────────────────────────────────────────────────────────────
test("S4: open subdir of active git workspace creates an independent exact-root workspace", async () => {
  const h = createHarness({
    workspaces: [gitWorkspace(FOO)],
    projects: [gitProject(FOO)],
    gitRoots: [FOO],
  });
  await openProject(h.session, FOO_SUB);
  const resp = getOpenResponse(h.emitted, "req-1");
  expect(resp?.workspace?.workspaceDirectory).toBe(FOO_SUB);
  expect(resp?.workspace?.projectId).not.toBe(workspaceByCwd(h.workspaces, FOO)?.projectId);
  expect(h.workspaces.size).toBe(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// S5. Open a subdir of an active non-git directory workspace: I4 says directory
//     workspaces do NOT claim their subtree. Subdir gets its own workspace.
// ─────────────────────────────────────────────────────────────────────────────
test("S5: open subdir of active non-git directory creates a SEPARATE workspace", async () => {
  const h = createHarness({
    workspaces: [dirWorkspace(BAR)],
    projects: [dirProject(BAR)],
  });
  await openProject(h.session, BAR_BAZ);
  const resp = getOpenResponse(h.emitted, "req-1");
  expect(resp?.workspace?.workspaceDirectory).toBe(BAR_BAZ);
  expect(hasWorkspaceCwd(h.workspaces, BAR)).toBe(true);
  expect(hasWorkspaceCwd(h.workspaces, BAR_BAZ)).toBe(true);
  expect(h.workspaces.size).toBe(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// S6. Explicit project opening allocates a fresh identity when only archived
//     records exist. Agent restore is the separate path that restores ownership.
// ─────────────────────────────────────────────────────────────────────────────
test("S6: re-opening an archived git workspace by exact path creates a fresh project and workspace", async () => {
  const archivedAt = "2026-04-22T13:08:05.400Z";
  const h = createHarness({
    workspaces: [gitWorkspace(TOOLBOX, archivedAt)],
    projects: [gitProject(TOOLBOX, archivedAt)],
    gitRoots: [TOOLBOX],
  });
  await openProject(h.session, TOOLBOX);
  const fresh = Array.from(h.workspaces.values()).find(
    (workspace) => workspace.cwd === TOOLBOX && !workspace.archivedAt,
  );
  expect(fresh?.workspaceId).not.toBe("ws-toolbox");
  expect(fresh?.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  expect(h.projects.get(TOOLBOX)?.archivedAt).toBe(archivedAt);
});

// ─────────────────────────────────────────────────────────────────────────────
// S7. Nested git: child has its own .git. Innermost wins → separate workspace.
// ─────────────────────────────────────────────────────────────────────────────
test("S7: open nested git repo (own .git) creates a SEPARATE workspace at the inner root", async () => {
  const h = createHarness({
    workspaces: [gitWorkspace(FOO)],
    projects: [gitProject(FOO)],
    gitRoots: [FOO, FOO_SUB],
  });
  await openProject(h.session, FOO_SUB);
  const resp = getOpenResponse(h.emitted, "req-1");
  expect(resp?.workspace?.workspaceDirectory).toBe(FOO_SUB);
  expect(hasWorkspaceCwd(h.workspaces, FOO)).toBe(true);
  expect(hasWorkspaceCwd(h.workspaces, FOO_SUB)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// S8. Open a child of an archived NON-GIT ancestor: I4 — ancestor doesn't claim
//     subtree. Fresh workspace at child path. Archived ancestor untouched.
//     This is the vfonic case from issue #564.
// ─────────────────────────────────────────────────────────────────────────────
test("S8: open child of archived non-git ancestor creates fresh workspace; ancestor stays archived", async () => {
  const archivedAt = "2026-04-04T17:15:22.423Z";
  const h = createHarness({
    workspaces: [dirWorkspace(USERS_DEVELOPER, archivedAt)],
    projects: [dirProject(USERS_DEVELOPER, archivedAt)],
  });
  await openProject(h.session, USERS_PROJECT);
  expect(workspaceByCwd(h.workspaces, USERS_DEVELOPER)?.archivedAt).toBe(archivedAt);
  expect(hasWorkspaceCwd(h.workspaces, USERS_PROJECT)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// S9. Open a child of an archived GIT ancestor: canonical resolves UP to the
//     archived root. Per "no auto-unarchive", the archived state is sticky.
//     This is the headline issue #564 reproduction (Edolce's video).
// ─────────────────────────────────────────────────────────────────────────────
test("S9: opening child of archived git workspace does NOT auto-unarchive the parent", async () => {
  const archivedAt = "2026-04-22T13:08:05.400Z";
  const h = createHarness({
    workspaces: [gitWorkspace(TOOLBOX, archivedAt)],
    projects: [gitProject(TOOLBOX, archivedAt)],
    gitRoots: [TOOLBOX],
  });
  await openProject(h.session, TOOLBOX_FLOMO);
  expect(workspaceByCwd(h.workspaces, TOOLBOX)?.archivedAt).toBe(archivedAt);
});

// ─────────────────────────────────────────────────────────────────────────────
// S10. The user's exact scenario:
//   1. Open `/projects` as a non-git directory workspace (mistake).
//   2. Archive it.
//   3. Open `/projects/some-git-repo` (a real git repo nested inside).
// Expected: the git repo opens as its own fresh workspace; archived `/projects`
// stays archived and is NOT resurfaced. Tests I4 (non-git ancestor doesn't
// claim subtree) interacting with a git child.
// ─────────────────────────────────────────────────────────────────────────────
test("S10: opening a git repo nested inside an archived non-git directory creates fresh workspace; ancestor stays archived", async () => {
  const archivedAt = "2026-04-04T17:15:22.423Z";
  const h = createHarness({
    workspaces: [dirWorkspace(PROJECTS, archivedAt)],
    projects: [dirProject(PROJECTS, archivedAt)],
    gitRoots: [SOME_GIT_REPO],
  });
  await openProject(h.session, SOME_GIT_REPO);
  const resp = getOpenResponse(h.emitted, "req-1");
  expect(resp?.error).toBeNull();
  expect(resp?.workspace?.workspaceDirectory).toBe(SOME_GIT_REPO);
  expect(resp?.workspace?.workspaceKind).toBe("local_checkout");
  expect(hasWorkspaceCwd(h.workspaces, SOME_GIT_REPO)).toBe(true);
  expect(workspaceByCwd(h.workspaces, PROJECTS)?.archivedAt).toBe(archivedAt);
  expect(h.projects.get(PROJECTS)?.archivedAt).toBe(archivedAt);
});

// ─────────────────────────────────────────────────────────────────────────────
// S11. Archive then re-add produces a fresh opaque identity; it never reuses
//      archived compatibility IDs.
// ─────────────────────────────────────────────────────────────────────────────
test("S11: re-opening an archived project by exact path keeps archived records and allocates fresh ids", async () => {
  const archivedAt = "2026-04-22T13:08:05.400Z";
  const h = createHarness({
    workspaces: [gitWorkspace(TOOLBOX, archivedAt)],
    projects: [gitProject(TOOLBOX, archivedAt)],
    gitRoots: [TOOLBOX],
  });
  await openProject(h.session, TOOLBOX);
  const resp = getOpenResponse(h.emitted, "req-1");
  expect(resp?.error).toBeNull();
  expect(resp?.workspace?.id).not.toBe("ws-toolbox");
  expect(resp?.workspace?.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  expect(h.workspaces.size).toBe(2);
  expect(h.projects.size).toBe(2);
  expect(h.projects.get(TOOLBOX)?.archivedAt).toBe(archivedAt);
});

// ─────────────────────────────────────────────────────────────────────────────
// S12. Prefix-fallback resolver must not surface an archived ancestor: looking
//      up a child cwd whose only matching record is an archived parent should
//      return null (not the archived parent). The behavior lives in
//      `resolveWorkspaceIdForPath` now; this invariant keeps archive-by-path
//      from accidentally resolving into an archived workspace subtree.
// ─────────────────────────────────────────────────────────────────────────────
test("S12: resolveWorkspaceIdForPath does not return archived ancestor via prefix fallback", async () => {
  const archivedAt = "2026-04-22T13:08:05.400Z";
  const h = createHarness({
    workspaces: [dirWorkspace(PARENT, archivedAt)],
    projects: [dirProject(PARENT, archivedAt)],
  });
  const found = resolveWorkspaceIdForPath(PARENT_CHILD, Array.from(h.workspaces.values()));
  expect(found).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// S13. Open a subfolder of an archived git repo when that subfolder is not
//      itself a separate git project: the new workspace is a plain directory.
//
// Archive is sticky (S9). The archived parent is out of scope, so there is
// no git project that owns the subfolder. Reviving the parent or inventing
// a second git project pointing at the same repo would both be worse than
// being explicit. To get git features back the user unarchives the parent
// (S6/S11).
// ─────────────────────────────────────────────────────────────────────────────
test("S13: subfolder of an archived git repo opens as its own git-backed workspace", async () => {
  const archivedAt = "2026-04-22T13:08:05.400Z";
  const h = createHarness({
    workspaces: [gitWorkspace(TOOLBOX, archivedAt)],
    projects: [gitProject(TOOLBOX, archivedAt)],
    gitRoots: [TOOLBOX],
  });
  await openProject(h.session, TOOLBOX_FLOMO);
  const resp = getOpenResponse(h.emitted, "req-1");
  expect(resp?.error).toBeNull();
  expect(resp?.workspace?.workspaceKind).toBe("local_checkout");
});
