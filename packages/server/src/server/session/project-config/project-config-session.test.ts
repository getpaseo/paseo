import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import { ProjectConfigSession, type ProjectConfigSessionHost } from "./project-config-session.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../../workspace-registry.js";
import type { SessionOutboundMessage } from "../../messages.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-config-session-test-")));
  tempDirs.push(root);
  return root;
}

function projectRecord(rootPath: string, archivedAt: string | null = null): PersistedProjectRecord {
  return {
    projectId: `project:${rootPath}`,
    rootPath,
    kind: "git",
    displayName: "Project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
  };
}

function workspaceRecord(
  projectId: string,
  cwd: string,
  archivedAt: string | null = null,
): PersistedWorkspaceRecord {
  return {
    workspaceId: `workspace:${cwd}`,
    projectId,
    cwd,
    kind: "worktree",
    displayName: "Workspace",
    branch: "feature",
    worktreeRoot: cwd,
    isPaseoOwnedWorktree: true,
    mainRepoRoot: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
  };
}

function makeSubsystem(
  records: PersistedProjectRecord[],
  workspaces: PersistedWorkspaceRecord[] = [],
) {
  const emitted: SessionOutboundMessage[] = [];
  const host: ProjectConfigSessionHost = { emit: (msg) => emitted.push(msg) };
  const subsystem = new ProjectConfigSession({
    host,
    projectRegistry: { list: async () => records },
    workspaceRegistry: { list: async () => workspaces },
    logger: pino({ level: "silent" }),
  });
  return { subsystem, emitted };
}

describe("ProjectConfigSession", () => {
  test("read resolves a known root despite a trailing slash and returns the raw config + revision", async () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "paseo.json"), JSON.stringify({ worktree: { setup: "npm ci" } }));
    const { subsystem, emitted } = makeSubsystem([projectRecord(repoRoot)]);

    await subsystem.handleReadProjectConfigRequest({
      type: "read_project_config_request",
      requestId: "read-1",
      repoRoot: `${repoRoot}/`,
    });

    expect(emitted).toEqual([
      {
        type: "read_project_config_response",
        payload: {
          requestId: "read-1",
          repoRoot,
          ok: true,
          config: { worktree: { setup: "npm ci" } },
          revision: expect.objectContaining({
            mtimeMs: expect.any(Number),
            size: expect.any(Number),
          }),
        },
      },
    ]);
  });

  // POSIX-only: creates a directory symlink without Windows privileges.
  test.skipIf(process.platform === "win32")(
    "read resolves a symlink to an active root via realpath",
    async () => {
      const repoRoot = makeRoot();
      writeFileSync(
        join(repoRoot, "paseo.json"),
        JSON.stringify({ worktree: { setup: "npm ci" } }),
      );
      const linkRoot = join(makeRoot(), "link");
      symlinkSync(repoRoot, linkRoot, "dir");
      const { subsystem, emitted } = makeSubsystem([projectRecord(repoRoot)]);

      await subsystem.handleReadProjectConfigRequest({
        type: "read_project_config_request",
        requestId: "read-symlink-1",
        repoRoot: linkRoot,
      });

      expect(emitted).toEqual([
        {
          type: "read_project_config_response",
          payload: {
            requestId: "read-symlink-1",
            repoRoot,
            ok: true,
            config: { worktree: { setup: "npm ci" } },
            revision: expect.objectContaining({
              mtimeMs: expect.any(Number),
              size: expect.any(Number),
            }),
          },
        },
      ]);
    },
  );

  test("read rejects archived and unknown roots with project_not_found", async () => {
    const archivedRoot = makeRoot();
    const unknownRoot = makeRoot();
    const { subsystem, emitted } = makeSubsystem([
      projectRecord(archivedRoot, "2026-01-02T00:00:00.000Z"),
    ]);

    await subsystem.handleReadProjectConfigRequest({
      type: "read_project_config_request",
      requestId: "archived-1",
      repoRoot: archivedRoot,
    });
    await subsystem.handleReadProjectConfigRequest({
      type: "read_project_config_request",
      requestId: "unknown-1",
      repoRoot: unknownRoot,
    });

    expect(emitted).toEqual([
      {
        type: "read_project_config_response",
        payload: {
          requestId: "archived-1",
          repoRoot: archivedRoot,
          ok: false,
          error: { code: "project_not_found" },
        },
      },
      {
        type: "read_project_config_response",
        payload: {
          requestId: "unknown-1",
          repoRoot: unknownRoot,
          ok: false,
          error: { code: "project_not_found" },
        },
      },
    ]);
  });

  test("write round-trips a config to a known root and echoes the new revision", async () => {
    const repoRoot = makeRoot();
    const { subsystem, emitted } = makeSubsystem([projectRecord(repoRoot)]);

    await subsystem.handleWriteProjectConfigRequest({
      type: "write_project_config_request",
      requestId: "write-1",
      repoRoot,
      config: { worktree: { setup: "npm ci" } },
      expectedRevision: null,
    });

    expect(emitted).toEqual([
      {
        type: "write_project_config_response",
        payload: {
          requestId: "write-1",
          repoRoot,
          ok: true,
          config: { worktree: { setup: "npm ci" } },
          revision: expect.objectContaining({
            mtimeMs: expect.any(Number),
            size: expect.any(Number),
          }),
        },
      },
    ]);
  });

  test("read and write accept an active workspace belonging to an active project", async () => {
    const repoRoot = makeRoot();
    const workspaceRoot = makeRoot();
    const project = projectRecord(repoRoot);
    const { subsystem, emitted } = makeSubsystem(
      [project],
      [workspaceRecord(project.projectId, workspaceRoot)],
    );

    await subsystem.handleWriteProjectConfigRequest({
      type: "write_project_config_request",
      requestId: "workspace-write-1",
      repoRoot: workspaceRoot,
      config: { worktree: { setup: "npm ci" } },
      expectedRevision: null,
    });
    await subsystem.handleReadProjectConfigRequest({
      type: "read_project_config_request",
      requestId: "workspace-read-1",
      repoRoot: workspaceRoot,
    });

    expect(emitted).toEqual([
      expect.objectContaining({
        type: "write_project_config_response",
        payload: expect.objectContaining({ ok: true, repoRoot: workspaceRoot }),
      }),
      expect.objectContaining({
        type: "read_project_config_response",
        payload: expect.objectContaining({
          ok: true,
          repoRoot: workspaceRoot,
          config: { worktree: { setup: "npm ci" } },
        }),
      }),
    ]);
  });

  test("read rejects archived workspaces and workspaces owned by archived projects", async () => {
    const activeRepoRoot = makeRoot();
    const archivedRepoRoot = makeRoot();
    const archivedWorkspaceRoot = makeRoot();
    const orphanedWorkspaceRoot = makeRoot();
    const activeProject = projectRecord(activeRepoRoot);
    const archivedProject = projectRecord(archivedRepoRoot, "2026-01-02T00:00:00.000Z");
    const { subsystem, emitted } = makeSubsystem(
      [activeProject, archivedProject],
      [
        workspaceRecord(activeProject.projectId, archivedWorkspaceRoot, "2026-01-02T00:00:00.000Z"),
        workspaceRecord(archivedProject.projectId, orphanedWorkspaceRoot),
      ],
    );

    for (const [requestId, repoRoot] of [
      ["archived-workspace", archivedWorkspaceRoot],
      ["archived-owner", orphanedWorkspaceRoot],
    ] as const) {
      await subsystem.handleReadProjectConfigRequest({
        type: "read_project_config_request",
        requestId,
        repoRoot,
      });
    }

    expect(emitted).toEqual([
      {
        type: "read_project_config_response",
        payload: {
          requestId: "archived-workspace",
          repoRoot: archivedWorkspaceRoot,
          ok: false,
          error: { code: "project_not_found" },
        },
      },
      {
        type: "read_project_config_response",
        payload: {
          requestId: "archived-owner",
          repoRoot: orphanedWorkspaceRoot,
          ok: false,
          error: { code: "project_not_found" },
        },
      },
    ]);
  });

  test("write rejects a stale revision and an unknown root with their inline domain failures", async () => {
    const staleRoot = makeRoot();
    writeFileSync(join(staleRoot, "paseo.json"), JSON.stringify({ worktree: { setup: "old" } }));
    const unknownRoot = makeRoot();
    const { subsystem, emitted } = makeSubsystem([projectRecord(staleRoot)]);

    await subsystem.handleWriteProjectConfigRequest({
      type: "write_project_config_request",
      requestId: "stale-1",
      repoRoot: staleRoot,
      config: { worktree: { setup: "new" } },
      expectedRevision: { mtimeMs: 1, size: 1 },
    });
    await subsystem.handleWriteProjectConfigRequest({
      type: "write_project_config_request",
      requestId: "unknown-write-1",
      repoRoot: unknownRoot,
      config: { worktree: { setup: "new" } },
      expectedRevision: null,
    });

    expect(emitted).toEqual([
      {
        type: "write_project_config_response",
        payload: {
          requestId: "stale-1",
          repoRoot: staleRoot,
          ok: false,
          error: {
            code: "stale_project_config",
            currentRevision: expect.objectContaining({
              mtimeMs: expect.any(Number),
              size: expect.any(Number),
            }),
          },
        },
      },
      {
        type: "write_project_config_response",
        payload: {
          requestId: "unknown-write-1",
          repoRoot: unknownRoot,
          ok: false,
          error: { code: "project_not_found" },
        },
      },
    ]);
  });
});
