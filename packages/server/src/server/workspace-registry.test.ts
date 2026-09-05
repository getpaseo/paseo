import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  DEFAULT_WORKSPACE_PIN_GROUP_ID,
  WorkspaceRegistryIntegrityError,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
} from "./workspace-registry.js";

function serializedJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function fileHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function missingHash(): string {
  return fileHash("workspace-pin-groups:file-missing");
}

function beforeImage(contents: string | null) {
  return contents === null
    ? { exists: false as const, contentHash: missingHash() }
    : { exists: true as const, contents, contentHash: fileHash(contents) };
}

function snapshotFileBytes(filePaths: readonly string[]): Map<string, string> {
  return new Map(filePaths.map((filePath) => [filePath, readFileSync(filePath, "utf8")]));
}

function expectFileBytesUnchanged(snapshot: ReadonlyMap<string, string>): void {
  for (const [filePath, contents] of snapshot) {
    expect(readFileSync(filePath, "utf8")).toBe(contents);
  }
}

function expectJournalIntegrityRecovery(
  failure: unknown,
  journalPath: string,
  snapshotPaths: readonly string[],
): void {
  expect(failure).toBeInstanceOf(WorkspaceRegistryIntegrityError);
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message).toContain(journalPath);
  expect(message).toContain("Recover only as a complete snapshot");
  for (const filePath of snapshotPaths) expect(message).toContain(filePath);
  expect(message).toContain(`delete ${journalPath} and restart the daemon`);
}

function pinGroupTransaction(input: {
  phase: "prepared" | "committed";
  beforeWorkspaces: string | null;
  afterWorkspaces: unknown[];
  beforePinGroups: string | null;
  afterPinGroups: Record<string, unknown>;
  beforePinGroupsBackup: string | null;
  beforeMarker?: string | null;
}) {
  const afterWorkspacesContents = serializedJson(input.afterWorkspaces);
  const afterPinGroupsContents = serializedJson(input.afterPinGroups);
  return {
    formatVersion: 1,
    phase: input.phase,
    beforeWorkspaces: beforeImage(input.beforeWorkspaces),
    afterWorkspaces: input.afterWorkspaces,
    afterWorkspacesContentHash: fileHash(afterWorkspacesContents),
    beforePinGroups: beforeImage(input.beforePinGroups),
    afterPinGroups: input.afterPinGroups,
    afterPinGroupsContentHash: fileHash(afterPinGroupsContents),
    beforePinGroupsBackup: beforeImage(input.beforePinGroupsBackup),
    afterPinGroupsBackupContentHash: fileHash(afterPinGroupsContents),
    beforeMarker: beforeImage(input.beforeMarker ?? null),
    afterMarkerContentHash: fileHash(`${JSON.stringify({ formatVersion: 1 })}\n`),
  };
}

function runBaselineWorkspaceUpdate(input: {
  sandboxRoot: string;
  workspaceFilePath: string;
}): void {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const baselineRoot = path.join(input.sandboxRoot, "ecec33265");
  const baselineFiles = [
    "packages/server/src/server/workspace-registry.ts",
    "packages/server/src/server/workspace-registry-model.ts",
    "packages/server/src/server/atomic-file.ts",
    "packages/server/src/utils/path.ts",
  ];
  for (const relativePath of baselineFiles) {
    const targetPath = path.join(baselineRoot, relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(
      targetPath,
      execFileSync("git", ["show", `ecec33265:${relativePath}`], { encoding: "utf8" }),
    );
  }
  symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(baselineRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const runnerPath = path.join(baselineRoot, "mutate-workspace.ts");
  writeFileSync(
    runnerPath,
    `import { FileBackedWorkspaceRegistry } from "./packages/server/src/server/workspace-registry.ts";
const logger: any = { child() { return this; }, error() {} };
void (async () => {
  const registry = new FileBackedWorkspaceRegistry(process.argv[2]!, logger);
  await registry.initialize();
  const updated = await registry.update("ws-survives-downgrade", (workspace) => ({
    ...workspace,
    displayName: "renamed by ecec33265",
    title: "Legacy title",
    pinnedAt: null,
    updatedAt: "2026-08-31T14:00:00.000Z",
  }));
  if (!updated) throw new Error("baseline registry did not load the workspace");
})();
`,
  );
  const tsxCliPath = createRequire(import.meta.url).resolve("tsx/cli");
  execFileSync(process.execPath, [tsxCliPath, runnerPath, input.workspaceFilePath], {
    cwd: baselineRoot,
    stdio: "pipe",
  });
}

describe("resolveWorkspaceName", () => {
  test("prefers the user-set title over the derived display name", () => {
    expect(
      resolveWorkspaceName({ title: "Payments work", derivedDisplayName: "feature/payments" }),
    ).toBe("Payments work");
  });

  test("falls back to the derived display name when there is no title", () => {
    expect(resolveWorkspaceName({ title: null, derivedDisplayName: "feature/payments" })).toBe(
      "feature/payments",
    );
  });

  test("resolveWorkspaceDisplayName applies the same rule over the persisted record", () => {
    const record = createPersistedWorkspaceRecord({
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      title: "Renamed",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(resolveWorkspaceDisplayName(record)).toBe("Renamed");
    expect(resolveWorkspaceDisplayName({ ...record, title: null })).toBe("main");
  });
});

describe("workspace registries", () => {
  let tmpDir: string;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-registry-"));
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates, updates, archives, deletes, and lists project records", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await projectRegistry.archive("remote:github.com/acme/repo", "2026-03-03T00:00:00.000Z");

    const archived = await projectRegistry.get("remote:github.com/acme/repo");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(await projectRegistry.list()).toHaveLength(1);

    await projectRegistry.remove("remote:github.com/acme/repo");
    expect(await projectRegistry.get("remote:github.com/acme/repo")).toBeNull();
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("preserves a concurrent project update when archiving", async () => {
    let pauseNextWrite = false;
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const concurrentRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "concurrent-projects.json"),
      logger,
      {
        writeRecords: async (filePath, records) => {
          if (pauseNextWrite) {
            pauseNextWrite = false;
            writeStarted();
            await release;
          }
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    const project = createPersistedProjectRecord({
      projectId: "project-concurrent",
      rootPath: "/tmp/project-concurrent",
      kind: "git",
      displayName: "project-concurrent",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await concurrentRegistry.upsert(project);
    pauseNextWrite = true;

    const update = concurrentRegistry.update(project.projectId, (current) => ({
      ...current,
      customName: "Kept name",
      updatedAt: "2026-03-02T00:00:00.000Z",
    }));
    await started;
    const archive = concurrentRegistry.archive(project.projectId, "2026-03-03T00:00:00.000Z");
    releaseWrite();
    await Promise.all([update, archive]);

    expect(await concurrentRegistry.get(project.projectId)).toMatchObject({
      customName: "Kept name",
      archivedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("publishes only project mutations that change the persisted lifecycle", async () => {
    await projectRegistry.initialize();
    const mutations: Array<{
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: ReturnType<typeof createPersistedProjectRecord> | null;
    }> = [];
    const unsubscribe = projectRegistry.subscribeToMutations((mutation) => {
      mutations.push(mutation);
    });
    const active = createPersistedProjectRecord({
      projectId: "project-one",
      rootPath: "/tmp/project-one",
      kind: "non_git",
      displayName: "project-one",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const archived = {
      ...active,
      updatedAt: "2026-03-02T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    };

    await projectRegistry.upsert(active);
    await projectRegistry.archive(active.projectId, archived.archivedAt);
    await projectRegistry.archive(active.projectId, "2026-03-03T00:00:00.000Z");
    await projectRegistry.archive("project-unknown", "2026-03-03T00:00:00.000Z");
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove("project-unknown");

    expect(mutations).toEqual([
      { kind: "upsert", projectId: active.projectId, project: active },
      { kind: "archive", projectId: active.projectId, project: archived },
      { kind: "remove", projectId: active.projectId, project: null },
    ]);
    unsubscribe();
  });

  test("atomically allocates one opaque project for concurrent exact-root adds", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "same-root");
    const projects = await Promise.all(
      Array.from({ length: 20 }, () =>
        projectRegistry.getOrCreateActiveByRoot({
          rootPath,
          kind: "non_git",
          displayName: "same-root",
          timestamp: "2026-03-01T00:00:00.000Z",
        }),
      ),
    );

    expect(new Set(projects.map((project) => project.projectId))).toEqual(
      new Set([projects[0]!.projectId]),
    );
    expect(projects[0]!.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(await projectRegistry.list()).toHaveLength(1);
  });

  test("keeps readable legacy IDs alongside newly allocated opaque IDs", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/legacy",
        kind: "git",
        displayName: "repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    const opaque = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "/tmp/new",
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    expect((await projectRegistry.get("remote:github.com/acme/repo"))?.rootPath).toBe(
      "/tmp/legacy",
    );
    expect(opaque.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  test("allocates a fresh opaque ID when only an archived exact root exists", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "archived-root");
    const archived = createPersistedProjectRecord({
      projectId: "prj_archived",
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(archived);

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      timestamp: "2026-03-03T00:00:00.000Z",
    });

    expect(created).toMatchObject({ rootPath, archivedAt: null });
    expect(created.projectId).not.toBe(archived.projectId);
    expect(await projectRegistry.get(archived.projectId)).toEqual(archived);
  });

  test("refreshes the oldest active legacy duplicate kind without rewriting its identity", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "legacy-root");
    const oldest = createPersistedProjectRecord({
      projectId: "remote:oldest",
      rootPath,
      kind: "git",
      displayName: "oldest",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const duplicate = createPersistedProjectRecord({
      projectId: "remote:duplicate",
      rootPath,
      kind: "git",
      displayName: "duplicate",
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(oldest);
    await projectRegistry.upsert(duplicate);

    await expect(
      projectRegistry.getOrCreateActiveByRoot({
        rootPath,
        kind: "non_git",
        displayName: "new-name",
        timestamp: "2026-03-03T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      ...oldest,
      kind: "non_git",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
    expect(await projectRegistry.list()).toEqual([
      { ...oldest, kind: "non_git", updatedAt: "2026-03-03T00:00:00.000Z" },
      duplicate,
    ]);
  });

  test("reuses an active project for Windows lexical-equivalent root spellings", async () => {
    await projectRegistry.initialize();
    const first = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "C:\\Users\\Paseo\\Repo",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const second = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "c:/users/paseo/repo/.",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(await projectRegistry.list()).toEqual([first]);
  });

  test("keeps lexical and symlink root spellings distinct without realpath", async () => {
    await projectRegistry.initialize();
    const target = path.join(tmpDir, "target");
    const link = path.join(tmpDir, "link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    const targetProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: target,
      kind: "non_git",
      displayName: "target",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const linkProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: link,
      kind: "non_git",
      displayName: "link",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(linkProject.projectId).not.toBe(targetProject.projectId);
    expect(await projectRegistry.list()).toEqual([targetProject, linkProject]);
  });

  test("retries a generated project ID collision", async () => {
    const generatedIds = ["prj_collision", "prj_fresh"];
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
      { projectIdFactory: () => generatedIds.shift() ?? "prj_unexpected" },
    );
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "prj_collision",
        rootPath: path.join(tmpDir, "existing"),
        kind: "non_git",
        displayName: "existing",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: path.join(tmpDir, "new"),
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(created.projectId).toBe("prj_fresh");
    expect(await projectRegistry.list()).toHaveLength(2);
  });

  test("project record schema accepts records without customName (legacy on-disk records)", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBeNull();
  });

  test("project record persists a customName override", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/home/me/work/repo",
        kind: "git",
        displayName: "acme/repo",
        customName: "Acme (work)",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBe("Acme (work)");
    expect(record?.displayName).toBe("acme/repo");
  });

  test("creates, updates, archives, deletes, and lists workspace records", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "feature/workspace",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.archive("/tmp/repo", "2026-03-03T00:00:00.000Z");

    const archived = await workspaceRegistry.get("/tmp/repo");
    expect(archived?.displayName).toBe("feature/workspace");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");

    await workspaceRegistry.remove("/tmp/repo");
    expect(await workspaceRegistry.get("/tmp/repo")).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("refreshes workspace archive timestamps when an archive is repeated", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-one",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-one", "2026-03-02T00:00:00.000Z");
    await workspaceRegistry.archive("workspace-one", "2026-03-03T00:00:00.000Z");

    expect(await workspaceRegistry.get("workspace-one")).toMatchObject({
      archivedAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("persists the consumed change request with the workspace archive", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-auto-archive",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "worktree",
        displayName: "feature",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-auto-archive", "2026-03-02T00:00:00.000Z", {
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });

    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloaded.initialize();
    expect(await reloaded.get("workspace-auto-archive")).toMatchObject({
      archivedAt: "2026-03-02T00:00:00.000Z",
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });
  });

  test("composes concurrent workspace field updates without losing either change", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await Promise.all([
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        title: "Payments work",
        updatedAt: "2026-03-02T00:00:00.000Z",
      })),
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        pinnedAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      })),
    ]);

    const reloadedRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloadedRegistry.initialize();
    expect(await reloadedRegistry.get("ws-1")).toMatchObject({
      title: "Payments work",
      pinnedAt: "2026-03-03T00:00:00.000Z",
      pinGroupId: DEFAULT_WORKSPACE_PIN_GROUP_ID,
    });
  });

  test("migrates the legacy workspace array and its pinned records into the default group", async () => {
    const filePath = path.join(tmpDir, "projects", "legacy-workspaces.json");
    mkdirSync(path.dirname(filePath), { recursive: true });
    const pinned = createPersistedWorkspaceRecord({
      workspaceId: "ws-pinned",
      projectId: "proj-1",
      cwd: "/tmp/pinned",
      kind: "directory",
      displayName: "pinned",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      pinnedAt: "2026-03-02T00:00:00.000Z",
    });
    const { pinGroupId, ...legacyPinned } = pinned;
    expect(pinGroupId).toBe(DEFAULT_WORKSPACE_PIN_GROUP_ID);
    writeFileSync(filePath, JSON.stringify([legacyPinned]));

    const migrated = new FileBackedWorkspaceRegistry(filePath, logger, {
      now: () => "2026-08-31T00:00:00.000Z",
    });
    await migrated.initialize();

    expect(await migrated.listPinGroups()).toEqual([
      {
        id: DEFAULT_WORKSPACE_PIN_GROUP_ID,
        name: "Pinned",
        createdAt: "2026-03-02T00:00:00.000Z",
      },
    ]);
    expect(await migrated.get("ws-pinned")).toMatchObject({
      pinGroupId: DEFAULT_WORKSPACE_PIN_GROUP_ID,
      pinnedAt: "2026-03-02T00:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject([
      {
        workspaceId: "ws-pinned",
        pinnedAt: "2026-03-02T00:00:00.000Z",
      },
    ]);
    expect(
      JSON.parse(
        readFileSync(path.join(tmpDir, "projects", "legacy-workspaces.pin-groups.json"), "utf8"),
      ),
    ).toMatchObject({
      groups: [{ id: DEFAULT_WORKSPACE_PIN_GROUP_ID, name: "Pinned" }],
      memberships: {
        "ws-pinned": {
          groupId: DEFAULT_WORKSPACE_PIN_GROUP_ID,
          assignedAt: "2026-03-02T00:00:00.000Z",
        },
      },
    });
  });

  test("reconciles mutations made by the actual ecec33265 registry after a downgrade", async () => {
    const filePath = path.join(tmpDir, "projects", "workspaces.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_focus",
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await registry.initialize();
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-survives-downgrade",
        projectId: "proj-1",
        cwd: "/tmp/survives-downgrade",
        kind: "directory",
        displayName: "survives-downgrade",
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:00:00.000Z",
      }),
    );
    await registry.setWorkspacePinGroup({
      workspaceId: "ws-survives-downgrade",
      groupId: DEFAULT_WORKSPACE_PIN_GROUP_ID,
      updatedAt: "2026-08-31T13:00:00.000Z",
    });

    runBaselineWorkspaceUpdate({ sandboxRoot: tmpDir, workspaceFilePath: filePath });

    const reupgraded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reupgraded.initialize();
    expect(await reupgraded.get("ws-survives-downgrade")).toMatchObject({
      workspaceId: "ws-survives-downgrade",
      displayName: "renamed by ecec33265",
      title: "Legacy title",
      updatedAt: "2026-08-31T14:00:00.000Z",
      pinnedAt: null,
      pinGroupId: null,
    });
    const reupgradedPrimaryBytes = readFileSync(filePath, "utf8");
    const reupgradedSidecar = JSON.parse(
      readFileSync(path.join(tmpDir, "projects", "workspace-pin-groups.json"), "utf8"),
    );
    expect(reupgradedSidecar).toMatchObject({
      formatVersion: 1,
      primaryContentHash: fileHash(reupgradedPrimaryBytes),
      memberships: {},
    });
  });

  test("moves the pre-release workspace envelope into the downgrade-safe sidecar", async () => {
    const filePath = path.join(tmpDir, "projects", "envelope-workspaces.json");
    mkdirSync(path.dirname(filePath), { recursive: true });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-envelope",
      projectId: "proj-1",
      cwd: "/tmp/envelope",
      kind: "directory",
      displayName: "envelope",
      createdAt: "2026-08-31T12:00:00.000Z",
      updatedAt: "2026-08-31T13:00:00.000Z",
      pinGroupId: "pgrp-focus",
    });
    writeFileSync(
      filePath,
      JSON.stringify({
        workspaces: [workspace],
        pinGroups: [
          {
            id: DEFAULT_WORKSPACE_PIN_GROUP_ID,
            name: "Pinned",
            createdAt: "2026-08-31T12:00:00.000Z",
          },
          {
            id: "pgrp-focus",
            name: "Focus",
            createdAt: "2026-08-31T12:01:00.000Z",
          },
        ],
      }),
    );

    const registry = new FileBackedWorkspaceRegistry(filePath, logger);
    await registry.initialize();

    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual([
      expect.objectContaining({ workspaceId: "ws-envelope", pinnedAt: null }),
    ]);
    expect(
      JSON.parse(
        readFileSync(path.join(tmpDir, "projects", "envelope-workspaces.pin-groups.json"), "utf8"),
      ),
    ).toMatchObject({
      groups: [{ id: DEFAULT_WORKSPACE_PIN_GROUP_ID }, { id: "pgrp-focus", name: "Focus" }],
      memberships: {
        "ws-envelope": {
          groupId: "pgrp-focus",
          assignedAt: "2026-08-31T13:00:00.000Z",
        },
      },
    });
  });

  test("refuses corrupt workspace bytes without overwriting them", async () => {
    const filePath = path.join(tmpDir, "projects", "corrupt-workspaces.json");
    mkdirSync(path.dirname(filePath), { recursive: true });
    const corruptBytes = '{"workspaceId":"truncated"';
    writeFileSync(filePath, corruptBytes);
    const registry = new FileBackedWorkspaceRegistry(filePath, logger);

    await expect(registry.initialize()).rejects.toThrow();
    await expect(
      registry.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: "ws-must-not-write",
          projectId: "proj-1",
          cwd: "/tmp/must-not-write",
          kind: "directory",
          displayName: "must-not-write",
          createdAt: "2026-08-31T12:00:00.000Z",
          updatedAt: "2026-08-31T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow();
    expect(readFileSync(filePath, "utf8")).toBe(corruptBytes);
  });

  test("refuses corrupt pin-group sidecar bytes without overwriting either file", async () => {
    const filePath = path.join(tmpDir, "projects", "workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "workspace-pin-groups.json");
    mkdirSync(path.dirname(filePath), { recursive: true });
    const workspaceBytes = "[]";
    const corruptSidecarBytes = '{"groups":[';
    writeFileSync(filePath, workspaceBytes);
    writeFileSync(sidecarPath, corruptSidecarBytes);
    const registry = new FileBackedWorkspaceRegistry(filePath, logger);

    await expect(registry.initialize()).rejects.toThrow();
    await expect(registry.createPinGroup("Must not write")).rejects.toThrow();
    expect(readFileSync(filePath, "utf8")).toBe(workspaceBytes);
    expect(readFileSync(sidecarPath, "utf8")).toBe(corruptSidecarBytes);
  });

  test("blocks a missing primary before established pin-group memberships can be discarded", async () => {
    const filePath = path.join(tmpDir, "projects", "missing-primary-workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "missing-primary-workspaces.pin-groups.json");
    const backupPath = path.join(
      tmpDir,
      "projects",
      "missing-primary-workspaces.pin-groups.backup.json",
    );
    const markerPath = path.join(
      tmpDir,
      "projects",
      "missing-primary-workspaces.pin-groups.expected.json",
    );
    const registry = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_preserved",
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await registry.initialize();
    const group = await registry.createPinGroup("Preserved");
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-preserved",
        projectId: "proj-1",
        cwd: "/tmp/preserved",
        kind: "directory",
        displayName: "preserved",
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:00:00.000Z",
      }),
    );
    await registry.setWorkspacePinGroup({
      workspaceId: "ws-preserved",
      groupId: group.id,
      updatedAt: "2026-08-31T13:00:00.000Z",
    });
    const sidecarBytes = readFileSync(sidecarPath, "utf8");
    const backupBytes = readFileSync(backupPath, "utf8");
    const markerBytes = readFileSync(markerPath, "utf8");
    rmSync(filePath);

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    const failure = await reloaded.initialize().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(WorkspaceRegistryIntegrityError);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    for (const expectedPath of [filePath, sidecarPath, backupPath, markerPath]) {
      expect(message).toContain(expectedPath);
    }
    expect(message).toContain(`Restore ${filePath} from backup and restart the daemon`);
    expect(message).toContain("To intentionally reset all workspace pin groups");
    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(sidecarPath, "utf8")).toBe(sidecarBytes);
    expect(readFileSync(backupPath, "utf8")).toBe(backupBytes);
    expect(readFileSync(markerPath, "utf8")).toBe(markerBytes);
    expect(JSON.parse(sidecarBytes)).toMatchObject({
      memberships: {
        "ws-preserved": { groupId: group.id, assignedAt: "2026-08-31T13:00:00.000Z" },
      },
    });
  });

  test("restores an expected missing sidecar from its committed backup", async () => {
    const filePath = path.join(tmpDir, "projects", "missing-sidecar-workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "missing-sidecar-workspaces.pin-groups.json");
    const backupPath = path.join(
      tmpDir,
      "projects",
      "missing-sidecar-workspaces.pin-groups.backup.json",
    );
    const registry = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_restored",
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await registry.initialize();
    await registry.createPinGroup("Restored");
    const expectedSidecarBytes = readFileSync(sidecarPath, "utf8");
    expect(readFileSync(backupPath, "utf8")).toBe(expectedSidecarBytes);
    rmSync(sidecarPath);

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reloaded.initialize();

    expect((await reloaded.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
      "pgrp_restored",
    ]);
    expect(readFileSync(sidecarPath, "utf8")).toBe(expectedSidecarBytes);
  });

  test("refuses to recreate pin groups when both expected catalog copies are missing", async () => {
    const filePath = path.join(tmpDir, "projects", "missing-catalog-workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "missing-catalog-workspaces.pin-groups.json");
    const backupPath = path.join(
      tmpDir,
      "projects",
      "missing-catalog-workspaces.pin-groups.backup.json",
    );
    const markerPath = path.join(
      tmpDir,
      "projects",
      "missing-catalog-workspaces.pin-groups.expected.json",
    );
    const registry = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_must_survive",
    });
    await registry.initialize();
    await registry.createPinGroup("Must survive");
    const primaryBytes = readFileSync(filePath, "utf8");
    const markerBytes = readFileSync(markerPath, "utf8");
    rmSync(sidecarPath);
    rmSync(backupPath);

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    await expect(reloaded.initialize()).rejects.toThrow(
      "Workspace pin-group sidecar and backup are missing",
    );
    expect(readFileSync(filePath, "utf8")).toBe(primaryBytes);
    expect(readFileSync(markerPath, "utf8")).toBe(markerBytes);
    expect(existsSync(sidecarPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
  });

  test.each(["sidecar", "backup", "marker"] as const)(
    "rejects a newer %s format without touching storage bytes",
    async (futureArtifact) => {
      const projectsPath = path.join(tmpDir, "projects");
      const filePath = path.join(projectsPath, "future-storage-workspaces.json");
      const sidecarPath = path.join(projectsPath, "future-storage-workspaces.pin-groups.json");
      const backupPath = path.join(
        projectsPath,
        "future-storage-workspaces.pin-groups.backup.json",
      );
      const markerPath = path.join(
        projectsPath,
        "future-storage-workspaces.pin-groups.expected.json",
      );
      const transactionPath = path.join(
        projectsPath,
        "future-storage-workspaces.pin-groups.transaction.json",
      );
      const registry = new FileBackedWorkspaceRegistry(filePath, logger);
      await registry.initialize();
      const futurePath = {
        sidecar: sidecarPath,
        backup: backupPath,
        marker: markerPath,
      }[futureArtifact];
      const futureValue =
        futureArtifact === "marker"
          ? { formatVersion: 2, futureMarker: { retained: true } }
          : {
              ...JSON.parse(readFileSync(futurePath, "utf8")),
              formatVersion: 2,
              futureCatalog: { retained: true },
            };
      writeFileSync(futurePath, JSON.stringify(futureValue));
      const artifactPaths = [filePath, sidecarPath, backupPath, markerPath];
      const untouched = snapshotFileBytes(artifactPaths);

      const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
      const failure = await reloaded.initialize().catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(WorkspaceRegistryIntegrityError);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(futurePath);
      expect(message).toContain("uses formatVersion 2");
      expect(message).toContain("valid state written by a newer daemon");
      expect(message).toContain("Keep every file unchanged");
      expect(message).toContain("Run a newer daemon version that understands this storage format");
      expect(message).not.toContain("restore");
      expect(message).not.toContain("delete");
      for (const artifactPath of [...artifactPaths, transactionPath]) {
        expect(message).toContain(artifactPath);
      }
      expectFileBytesUnchanged(untouched);
      expect(existsSync(transactionPath)).toBe(false);
    },
  );

  test("loads a current-version sidecar and backup normally", async () => {
    const filePath = path.join(tmpDir, "projects", "current-sidecar-workspaces.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_current",
    });
    await registry.initialize();
    await registry.createPinGroup("Current");

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    expect((await reloaded.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
      "pgrp_current",
    ]);
  });

  test("migrates fresh storage when the sidecar is absent", async () => {
    const projectsPath = path.join(tmpDir, "projects");
    const filePath = path.join(projectsPath, "fresh-sidecar-workspaces.json");
    const sidecarPath = path.join(projectsPath, "fresh-sidecar-workspaces.pin-groups.json");
    const backupPath = path.join(projectsPath, "fresh-sidecar-workspaces.pin-groups.backup.json");
    const markerPath = path.join(projectsPath, "fresh-sidecar-workspaces.pin-groups.expected.json");
    for (const artifactPath of [filePath, sidecarPath, backupPath, markerPath]) {
      expect(existsSync(artifactPath)).toBe(false);
    }

    const registry = new FileBackedWorkspaceRegistry(filePath, logger);
    await registry.initialize();

    expect((await registry.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
    ]);
    expect(JSON.parse(readFileSync(sidecarPath, "utf8"))).toMatchObject({ formatVersion: 1 });
    expect(readFileSync(backupPath, "utf8")).toBe(readFileSync(sidecarPath, "utf8"));
    expect(readFileSync(markerPath, "utf8")).toBe(`${JSON.stringify({ formatVersion: 1 })}\n`);
  });

  test("rejects a newer transaction format without touching registry bytes", async () => {
    const filePath = path.join(tmpDir, "projects", "future-journal-workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "future-journal-workspaces.pin-groups.json");
    const backupPath = path.join(
      tmpDir,
      "projects",
      "future-journal-workspaces.pin-groups.backup.json",
    );
    const markerPath = path.join(
      tmpDir,
      "projects",
      "future-journal-workspaces.pin-groups.expected.json",
    );
    const transactionPath = path.join(
      tmpDir,
      "projects",
      "future-journal-workspaces.pin-groups.transaction.json",
    );
    const registry = new FileBackedWorkspaceRegistry(filePath, logger);
    await registry.initialize();
    const workspaceBytes = readFileSync(filePath, "utf8");
    const futureJournalBytes = JSON.stringify({ formatVersion: 2, futureRecovery: true });
    writeFileSync(transactionPath, futureJournalBytes);
    const artifactPaths = [filePath, sidecarPath, backupPath, markerPath, transactionPath];
    const untouched = snapshotFileBytes(artifactPaths);

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    const failure = await reloaded.initialize().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(WorkspaceRegistryIntegrityError);
    const message = (failure as Error).message;
    expect(message).toContain("valid state written by a newer daemon");
    expect(message).toContain("Run a newer daemon version that understands this journal format");
    expect(message).toContain("Keep every file unchanged");
    expect(message).not.toContain("delete");
    for (const artifactPath of artifactPaths) expect(message).toContain(artifactPath);
    expectFileBytesUnchanged(untouched);
    expect(readFileSync(filePath, "utf8")).toBe(workspaceBytes);
    expect(readFileSync(transactionPath, "utf8")).toBe(futureJournalBytes);
  });

  test("blocks a malformed transaction journal with complete-snapshot recovery steps", async () => {
    const projectsPath = path.join(tmpDir, "projects");
    const filePath = path.join(projectsPath, "workspaces.json");
    const sidecarPath = path.join(projectsPath, "workspace-pin-groups.json");
    const backupPath = path.join(projectsPath, "workspace-pin-groups.backup.json");
    const markerPath = path.join(projectsPath, "workspace-pin-groups.expected.json");
    const transactionPath = path.join(projectsPath, "workspace-pin-groups.transaction.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, logger);
    await registry.initialize();
    writeFileSync(transactionPath, "CORRUPT_TRANSACTION_JOURNAL");
    const artifactPaths = [filePath, sidecarPath, backupPath, markerPath, transactionPath];
    const untouched = snapshotFileBytes(artifactPaths);

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    const failure = await reloaded.initialize().catch((cause: unknown) => cause);

    expectJournalIntegrityRecovery(failure, transactionPath, artifactPaths.slice(0, 4));
    expectFileBytesUnchanged(untouched);
  });

  test("blocks an EACCES transaction read as a registry integrity failure", async () => {
    const projectsPath = path.join(tmpDir, "projects");
    const filePath = path.join(projectsPath, "workspaces.json");
    const sidecarPath = path.join(projectsPath, "workspace-pin-groups.json");
    const backupPath = path.join(projectsPath, "workspace-pin-groups.backup.json");
    const markerPath = path.join(projectsPath, "workspace-pin-groups.expected.json");
    const transactionPath = path.join(projectsPath, "workspace-pin-groups.transaction.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, logger);
    await registry.initialize();
    const primaryBytes = readFileSync(filePath, "utf8");
    const sidecarBytes = readFileSync(sidecarPath, "utf8");
    const backupBytes = readFileSync(backupPath, "utf8");
    const markerBytes = readFileSync(markerPath, "utf8");
    writeFileSync(
      transactionPath,
      serializedJson(
        pinGroupTransaction({
          phase: "prepared",
          beforeWorkspaces: primaryBytes,
          afterWorkspaces: JSON.parse(primaryBytes),
          beforePinGroups: sidecarBytes,
          afterPinGroups: JSON.parse(sidecarBytes),
          beforePinGroupsBackup: backupBytes,
          beforeMarker: markerBytes,
        }),
      ),
    );
    const artifactPaths = [filePath, sidecarPath, backupPath, markerPath, transactionPath];
    const untouched = snapshotFileBytes(artifactPaths);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger, {
      readPinGroupsTransactionFile: async () => {
        throw permissionError;
      },
    });
    const failure = await reloaded.initialize().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(WorkspaceRegistryIntegrityError);
    const message = (failure as Error).message;
    expect(message).toContain(transactionPath);
    expect(message).toContain("Repair filesystem permissions or ownership");
    expect(message).toContain("EACCES: permission denied");
    expect(message).not.toContain("Recover only as a complete snapshot");
    expect(message).not.toContain("delete");
    for (const artifactPath of artifactPaths.slice(0, 4)) expect(message).toContain(artifactPath);
    expectFileBytesUnchanged(untouched);
  });

  test("blocks a transaction journal replaced by a directory", async () => {
    const projectsPath = path.join(tmpDir, "projects");
    const filePath = path.join(projectsPath, "workspaces.json");
    const sidecarPath = path.join(projectsPath, "workspace-pin-groups.json");
    const backupPath = path.join(projectsPath, "workspace-pin-groups.backup.json");
    const markerPath = path.join(projectsPath, "workspace-pin-groups.expected.json");
    const transactionPath = path.join(projectsPath, "workspace-pin-groups.transaction.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, logger);
    await registry.initialize();
    mkdirSync(transactionPath);
    const artifactPaths = [filePath, sidecarPath, backupPath, markerPath];
    const untouched = snapshotFileBytes(artifactPaths);

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    const failure = await reloaded.initialize().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(WorkspaceRegistryIntegrityError);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(transactionPath);
    expect(message).toContain("filesystem state is invalid");
    expect(message).toContain("EISDIR");
    expect(message).not.toContain("Recover only as a complete snapshot");
    for (const artifactPath of artifactPaths) expect(message).toContain(artifactPath);
    expectFileBytesUnchanged(untouched);
    expect(statSync(transactionPath).isDirectory()).toBe(true);
  });

  test("keeps EAGAIN transaction reads on the ordinary retry path", async () => {
    const projectsPath = path.join(tmpDir, "projects");
    const filePath = path.join(projectsPath, "workspaces.json");
    const sidecarPath = path.join(projectsPath, "workspace-pin-groups.json");
    const backupPath = path.join(projectsPath, "workspace-pin-groups.backup.json");
    const markerPath = path.join(projectsPath, "workspace-pin-groups.expected.json");
    const transactionPath = path.join(projectsPath, "workspace-pin-groups.transaction.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, logger);
    await registry.initialize();
    writeFileSync(transactionPath, "TRANSIENT_TRANSACTION_JOURNAL");
    const artifactPaths = [filePath, sidecarPath, backupPath, markerPath, transactionPath];
    const untouched = snapshotFileBytes(artifactPaths);
    const transientError = Object.assign(new Error("try again"), { code: "EAGAIN" });

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger, {
      readPinGroupsTransactionFile: async () => {
        throw transientError;
      },
    });
    const failure = await reloaded.initialize().catch((cause: unknown) => cause);

    expect(failure).toBe(transientError);
    expect(failure).not.toBeInstanceOf(WorkspaceRegistryIntegrityError);
    expectFileBytesUnchanged(untouched);
  });

  test("converges a split prepared transaction around a newer legacy primary write", async () => {
    const filePath = path.join(tmpDir, "projects", "stale-journal-workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "stale-journal-workspaces.pin-groups.json");
    const backupPath = path.join(
      tmpDir,
      "projects",
      "stale-journal-workspaces.pin-groups.backup.json",
    );
    const markerPath = path.join(
      tmpDir,
      "projects",
      "stale-journal-workspaces.pin-groups.expected.json",
    );
    const transactionPath = path.join(
      tmpDir,
      "projects",
      "stale-journal-workspaces.pin-groups.transaction.json",
    );
    const registry = new FileBackedWorkspaceRegistry(filePath, logger, {
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await registry.initialize();
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-newer-primary",
        projectId: "proj-1",
        cwd: "/tmp/newer-primary",
        kind: "directory",
        displayName: "before legacy write",
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:00:00.000Z",
      }),
    );
    const beforeWorkspaceBytes = readFileSync(filePath, "utf8");
    const beforeSidecarBytes = readFileSync(sidecarPath, "utf8");
    const beforeBackupBytes = readFileSync(backupPath, "utf8");
    const beforeMarkerBytes = readFileSync(markerPath, "utf8");
    const afterPinGroups = JSON.parse(beforeSidecarBytes);
    afterPinGroups.groups.push({
      id: "pgrp_interrupted",
      name: "Interrupted",
      createdAt: "2026-08-31T13:00:00.000Z",
    });
    afterPinGroups.memberships["ws-newer-primary"] = {
      groupId: "pgrp_interrupted",
      assignedAt: "2026-08-31T13:00:00.000Z",
    };
    const afterSidecarBytes = serializedJson(afterPinGroups);
    writeFileSync(
      transactionPath,
      serializedJson(
        pinGroupTransaction({
          phase: "prepared",
          beforeWorkspaces: beforeWorkspaceBytes,
          afterWorkspaces: JSON.parse(beforeWorkspaceBytes),
          beforePinGroups: beforeSidecarBytes,
          afterPinGroups,
          beforePinGroupsBackup: beforeBackupBytes,
          beforeMarker: beforeMarkerBytes,
        }),
      ),
    );
    // Exact interrupted window: the sidecar reached its after-image, while its
    // mirror remained at the before-image and the old daemon then wrote primary.
    writeFileSync(sidecarPath, afterSidecarBytes);
    const legacyRecords = JSON.parse(beforeWorkspaceBytes);
    legacyRecords[0].displayName = "written by old daemon";
    legacyRecords[0].updatedAt = "2026-08-31T14:00:00.000Z";
    const newerPrimaryBytes = serializedJson(legacyRecords);
    writeFileSync(filePath, newerPrimaryBytes);

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reloaded.initialize();

    expect(await reloaded.get("ws-newer-primary")).toMatchObject({
      displayName: "written by old daemon",
      updatedAt: "2026-08-31T14:00:00.000Z",
      pinGroupId: "pgrp_interrupted",
      pinGroupAssignedAt: "2026-08-31T13:00:00.000Z",
      pinnedAt: null,
    });
    expect((await reloaded.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
      "pgrp_interrupted",
    ]);
    expect(readFileSync(filePath, "utf8")).toBe(newerPrimaryBytes);
    const convergedSidecarBytes = readFileSync(sidecarPath, "utf8");
    expect(readFileSync(backupPath, "utf8")).toBe(convergedSidecarBytes);
    expect(JSON.parse(convergedSidecarBytes)).toMatchObject({
      primaryContentHash: fileHash(newerPrimaryBytes),
      memberships: {
        "ws-newer-primary": {
          groupId: "pgrp_interrupted",
          assignedAt: "2026-08-31T13:00:00.000Z",
        },
      },
    });
    expect(existsSync(transactionPath)).toBe(false);
  });

  test("blocks a missing prepared auxiliary artifact until the whole snapshot is restored", async () => {
    const filePath = path.join(tmpDir, "projects", "ambiguous-workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "ambiguous-workspaces.pin-groups.json");
    const backupPath = path.join(tmpDir, "projects", "ambiguous-workspaces.pin-groups.backup.json");
    const markerPath = path.join(
      tmpDir,
      "projects",
      "ambiguous-workspaces.pin-groups.expected.json",
    );
    const transactionPath = path.join(
      tmpDir,
      "projects",
      "ambiguous-workspaces.pin-groups.transaction.json",
    );
    const baseline = new FileBackedWorkspaceRegistry(filePath, logger);
    await baseline.initialize();
    const beforeWorkspaceBytes = readFileSync(filePath, "utf8");
    const beforeSidecarBytes = readFileSync(sidecarPath, "utf8");
    const beforeBackupBytes = readFileSync(backupPath, "utf8");
    const beforeMarkerBytes = readFileSync(markerPath, "utf8");
    const afterPinGroups = JSON.parse(beforeSidecarBytes);
    afterPinGroups.groups.push({
      id: "pgrp_ambiguous",
      name: "Ambiguous",
      createdAt: "2026-08-31T13:00:00.000Z",
    });
    writeFileSync(
      transactionPath,
      serializedJson(
        pinGroupTransaction({
          phase: "prepared",
          beforeWorkspaces: beforeWorkspaceBytes,
          afterWorkspaces: JSON.parse(beforeWorkspaceBytes),
          beforePinGroups: beforeSidecarBytes,
          afterPinGroups,
          beforePinGroupsBackup: beforeBackupBytes,
          beforeMarker: beforeMarkerBytes,
        }),
      ),
    );
    const newerPrimaryBytes = `${beforeWorkspaceBytes}\n`;
    writeFileSync(filePath, newerPrimaryBytes);
    rmSync(backupPath);
    const journalBytes = readFileSync(transactionPath, "utf8");

    const blocked = new FileBackedWorkspaceRegistry(filePath, logger);
    const failure = await blocked.initialize().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(WorkspaceRegistryIntegrityError);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`restore ${filePath} to SHA-256 ${fileHash(beforeWorkspaceBytes)}`);
    expect(message).toContain(`restore ${sidecarPath} to SHA-256 ${fileHash(beforeSidecarBytes)}`);
    expect(message).toContain(`restore ${backupPath} to SHA-256 ${fileHash(beforeBackupBytes)}`);
    expect(message).toContain(`restore ${markerPath} to SHA-256 ${fileHash(beforeMarkerBytes)}`);
    expect(message).toContain(`delete ${transactionPath}`);
    expect(readFileSync(filePath, "utf8")).toBe(newerPrimaryBytes);
    expect(readFileSync(sidecarPath, "utf8")).toBe(beforeSidecarBytes);
    expect(existsSync(backupPath)).toBe(false);
    expect(readFileSync(markerPath, "utf8")).toBe(beforeMarkerBytes);
    expect(readFileSync(transactionPath, "utf8")).toBe(journalBytes);

    // Follow the advertised complete-snapshot recovery exactly.
    writeFileSync(filePath, beforeWorkspaceBytes);
    writeFileSync(sidecarPath, beforeSidecarBytes);
    writeFileSync(backupPath, beforeBackupBytes);
    writeFileSync(markerPath, beforeMarkerBytes);
    rmSync(transactionPath);
    const recovered = new FileBackedWorkspaceRegistry(filePath, logger);
    await recovered.initialize();
    expect((await recovered.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
    ]);
  });

  test("rolls back a durable prepared journal whose write acknowledgement is lost", async () => {
    const filePath = path.join(tmpDir, "projects", "lost-prepare-ack-workspaces.json");
    const sidecarPath = path.join(
      tmpDir,
      "projects",
      "lost-prepare-ack-workspaces.pin-groups.json",
    );
    const transactionPath = path.join(
      tmpDir,
      "projects",
      "lost-prepare-ack-workspaces.pin-groups.transaction.json",
    );
    const baseline = new FileBackedWorkspaceRegistry(filePath, logger, {
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await baseline.initialize();
    const beforeWorkspaceBytes = readFileSync(filePath, "utf8");
    const beforeSidecarBytes = readFileSync(sidecarPath, "utf8");
    let losePreparedAcknowledgement = true;
    const registry = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_lost_ack",
      now: () => "2026-08-31T13:00:00.000Z",
      writePinGroupsTransaction: async (targetPath, transaction) => {
        writeFileSync(targetPath, `${JSON.stringify(transaction)}\n`);
        if (losePreparedAcknowledgement && transaction.phase === "prepared") {
          losePreparedAcknowledgement = false;
          throw new Error("prepared journal acknowledgement lost");
        }
      },
    });
    await registry.initialize();

    await expect(registry.createPinGroup("Must roll back")).rejects.toThrow(
      "prepared journal acknowledgement lost",
    );
    expect(existsSync(transactionPath)).toBe(false);
    expect(readFileSync(filePath, "utf8")).toBe(beforeWorkspaceBytes);
    expect(readFileSync(sidecarPath, "utf8")).toBe(beforeSidecarBytes);

    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-after-lost-prepare-ack",
        projectId: "proj-1",
        cwd: "/tmp/after-lost-prepare-ack",
        kind: "directory",
        displayName: "after-lost-prepare-ack",
        createdAt: "2026-08-31T14:00:00.000Z",
        updatedAt: "2026-08-31T14:00:00.000Z",
      }),
    );

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reloaded.initialize();
    expect(await reloaded.get("ws-after-lost-prepare-ack")).toMatchObject({
      workspaceId: "ws-after-lost-prepare-ack",
    });
    expect((await reloaded.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
    ]);
  });

  test("rolls back a prepared pin-group transaction after the sidecar write fails", async () => {
    const filePath = path.join(tmpDir, "projects", "sidecar-failure-workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "sidecar-failure-workspaces.pin-groups.json");
    const transactionPath = path.join(
      tmpDir,
      "projects",
      "sidecar-failure-workspaces.pin-groups.transaction.json",
    );
    const baseline = new FileBackedWorkspaceRegistry(filePath, logger, {
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await baseline.initialize();
    const beforeWorkspaceBytes = " [\n]\n";
    const beforeSidecarBytes = ` ${JSON.stringify(JSON.parse(readFileSync(sidecarPath, "utf8")))}\n`;
    writeFileSync(filePath, beforeWorkspaceBytes);
    writeFileSync(sidecarPath, beforeSidecarBytes);

    const failing = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_rejected",
      now: () => "2026-08-31T13:00:00.000Z",
      writePinGroupsFile: async (targetPath, state) => {
        writeFileSync(targetPath, serializedJson(state));
        throw new Error("sidecar write failed");
      },
      writeRawFile: async () => {
        throw new Error("simulated process interruption before rollback");
      },
    });
    await failing.initialize();
    await expect(failing.createPinGroup("Rejected")).rejects.toThrow(
      "Workspace pin-group storage outcome is uncertain",
    );
    expect(JSON.parse(readFileSync(transactionPath, "utf8"))).toMatchObject({
      phase: "prepared",
    });

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reloaded.initialize();
    expect((await reloaded.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
    ]);
    expect(readFileSync(filePath, "utf8")).toBe(beforeWorkspaceBytes);
    expect(readFileSync(sidecarPath, "utf8")).toBe(beforeSidecarBytes);
  });

  test("rolls back sidecar membership after the workspace-array write fails", async () => {
    const filePath = path.join(tmpDir, "projects", "workspace-failure-workspaces.json");
    const sidecarPath = path.join(
      tmpDir,
      "projects",
      "workspace-failure-workspaces.pin-groups.json",
    );
    const transactionPath = path.join(
      tmpDir,
      "projects",
      "workspace-failure-workspaces.pin-groups.transaction.json",
    );
    const baseline = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_focus",
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await baseline.initialize();
    await baseline.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-rejected-membership",
        projectId: "proj-1",
        cwd: "/tmp/rejected-membership",
        kind: "directory",
        displayName: "rejected-membership",
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:00:00.000Z",
      }),
    );
    const focus = await baseline.createPinGroup("Focus");
    const workspaceWithFutureField = JSON.parse(readFileSync(filePath, "utf8"));
    workspaceWithFutureField[0].futureWorkspaceVersion = 2;
    const beforeWorkspaceBytes = `${JSON.stringify(workspaceWithFutureField)}\n`;
    const beforeSidecarBytes = ` ${JSON.stringify(JSON.parse(readFileSync(sidecarPath, "utf8")))}\n`;
    writeFileSync(filePath, beforeWorkspaceBytes);
    writeFileSync(sidecarPath, beforeSidecarBytes);

    const failing = new FileBackedWorkspaceRegistry(filePath, logger, {
      writeRecords: async () => {
        throw new Error("workspace array write failed");
      },
      writeRawFile: async () => {
        throw new Error("simulated process interruption before rollback");
      },
    });
    await failing.initialize();
    await expect(
      failing.setWorkspacePinGroup({
        workspaceId: "ws-rejected-membership",
        groupId: focus.id,
        updatedAt: "2026-08-31T13:00:00.000Z",
      }),
    ).rejects.toThrow("Workspace pin-group storage outcome is uncertain");
    expect(JSON.parse(readFileSync(transactionPath, "utf8"))).toMatchObject({
      phase: "prepared",
    });

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reloaded.initialize();
    expect(await reloaded.get("ws-rejected-membership")).toMatchObject({
      pinGroupId: null,
      pinGroupAssignedAt: null,
      pinnedAt: null,
    });
    expect(readFileSync(filePath, "utf8")).toBe(beforeWorkspaceBytes);
    expect(readFileSync(sidecarPath, "utf8")).toBe(beforeSidecarBytes);
  });

  test("replays missing and known pre-transaction files from a committed journal", async () => {
    const filePath = path.join(tmpDir, "projects", "committed-workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "committed-workspaces.pin-groups.json");
    const backupPath = path.join(tmpDir, "projects", "committed-workspaces.pin-groups.backup.json");
    const markerPath = path.join(
      tmpDir,
      "projects",
      "committed-workspaces.pin-groups.expected.json",
    );
    const transactionPath = path.join(
      tmpDir,
      "projects",
      "committed-workspaces.pin-groups.transaction.json",
    );
    const baseline = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_committed",
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await baseline.initialize();
    await baseline.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-committed",
        projectId: "proj-1",
        cwd: "/tmp/committed",
        kind: "directory",
        displayName: "committed",
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:00:00.000Z",
      }),
    );
    await baseline.createPinGroup("Committed");
    const afterWorkspaceBytes = readFileSync(filePath, "utf8");
    const afterSidecarBytes = readFileSync(sidecarPath, "utf8");
    const beforeWorkspaceBytes = "[]";
    writeFileSync(
      transactionPath,
      JSON.stringify(
        pinGroupTransaction({
          phase: "committed",
          beforeWorkspaces: beforeWorkspaceBytes,
          afterWorkspaces: JSON.parse(afterWorkspaceBytes),
          beforePinGroups: null,
          afterPinGroups: JSON.parse(afterSidecarBytes),
          beforePinGroupsBackup: null,
        }),
      ),
    );
    writeFileSync(filePath, beforeWorkspaceBytes);
    rmSync(sidecarPath);
    rmSync(backupPath);
    rmSync(markerPath);

    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reloaded.initialize();

    expect((await reloaded.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
      "pgrp_committed",
    ]);
    expect(readFileSync(filePath, "utf8")).toBe(afterWorkspaceBytes);
    expect(readFileSync(sidecarPath, "utf8")).toBe(afterSidecarBytes);
    expect(readFileSync(backupPath, "utf8")).toBe(afterSidecarBytes);
    expect(await reloaded.get("ws-committed")).toMatchObject({ workspaceId: "ws-committed" });
    expect(existsSync(markerPath)).toBe(true);
    expect(existsSync(transactionPath)).toBe(false);
  });

  test("preserves a later downgrade write while completing committed journal recovery", async () => {
    const filePath = path.join(tmpDir, "projects", "workspaces.json");
    const sidecarPath = path.join(tmpDir, "projects", "workspace-pin-groups.json");
    const backupPath = path.join(tmpDir, "projects", "workspace-pin-groups.backup.json");
    const markerPath = path.join(tmpDir, "projects", "workspace-pin-groups.expected.json");
    const transactionPath = path.join(tmpDir, "projects", "workspace-pin-groups.transaction.json");
    const baseline = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_focus",
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await baseline.initialize();
    await baseline.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-survives-downgrade",
        projectId: "proj-1",
        cwd: "/tmp/committed-downgrade",
        kind: "directory",
        displayName: "before downgrade",
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:00:00.000Z",
      }),
    );
    const focus = await baseline.createPinGroup("Focus");
    const beforeWorkspaceBytes = readFileSync(filePath, "utf8");
    const beforeSidecarBytes = readFileSync(sidecarPath, "utf8");
    const beforeBackupBytes = readFileSync(backupPath, "utf8");
    const beforeMarkerBytes = readFileSync(markerPath, "utf8");
    await baseline.setWorkspacePinGroup({
      workspaceId: "ws-survives-downgrade",
      groupId: focus.id,
      updatedAt: "2026-08-31T13:00:00.000Z",
    });
    const afterWorkspaceBytes = readFileSync(filePath, "utf8");
    const afterSidecarBytes = readFileSync(sidecarPath, "utf8");
    writeFileSync(
      transactionPath,
      serializedJson(
        pinGroupTransaction({
          phase: "committed",
          beforeWorkspaces: beforeWorkspaceBytes,
          afterWorkspaces: JSON.parse(afterWorkspaceBytes),
          beforePinGroups: beforeSidecarBytes,
          afterPinGroups: JSON.parse(afterSidecarBytes),
          beforePinGroupsBackup: beforeBackupBytes,
          beforeMarker: beforeMarkerBytes,
        }),
      ),
    );

    runBaselineWorkspaceUpdate({ sandboxRoot: tmpDir, workspaceFilePath: filePath });

    const reupgraded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reupgraded.initialize();

    expect(await reupgraded.get("ws-survives-downgrade")).toMatchObject({
      displayName: "renamed by ecec33265",
      title: "Legacy title",
      updatedAt: "2026-08-31T14:00:00.000Z",
      pinGroupId: focus.id,
      pinGroupAssignedAt: "2026-08-31T13:00:00.000Z",
      pinnedAt: null,
    });
    expect((await reupgraded.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
      focus.id,
    ]);
    const finalPrimaryBytes = readFileSync(filePath, "utf8");
    const finalSidecarBytes = readFileSync(sidecarPath, "utf8");
    expect(readFileSync(backupPath, "utf8")).toBe(finalSidecarBytes);
    expect(JSON.parse(finalSidecarBytes)).toMatchObject({
      primaryContentHash: fileHash(finalPrimaryBytes),
      memberships: {
        "ws-survives-downgrade": {
          groupId: focus.id,
          assignedAt: "2026-08-31T13:00:00.000Z",
        },
      },
    });
    expect(existsSync(transactionPath)).toBe(false);
  });

  test("leaves every artifact untouched when a committed journal has a corrupt later primary", async () => {
    const filePath = path.join(tmpDir, "projects", "corrupt-committed-workspaces.json");
    const sidecarPath = path.join(
      tmpDir,
      "projects",
      "corrupt-committed-workspaces.pin-groups.json",
    );
    const backupPath = path.join(
      tmpDir,
      "projects",
      "corrupt-committed-workspaces.pin-groups.backup.json",
    );
    const markerPath = path.join(
      tmpDir,
      "projects",
      "corrupt-committed-workspaces.pin-groups.expected.json",
    );
    const transactionPath = path.join(
      tmpDir,
      "projects",
      "corrupt-committed-workspaces.pin-groups.transaction.json",
    );
    const baseline = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_corrupt_committed",
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await baseline.initialize();
    await baseline.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-corrupt-committed",
        projectId: "proj-1",
        cwd: "/tmp/corrupt-committed",
        kind: "directory",
        displayName: "corrupt-committed",
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:00:00.000Z",
      }),
    );
    const group = await baseline.createPinGroup("Corrupt committed");
    const beforeWorkspaceBytes = readFileSync(filePath, "utf8");
    const beforeSidecarBytes = readFileSync(sidecarPath, "utf8");
    const beforeBackupBytes = readFileSync(backupPath, "utf8");
    const beforeMarkerBytes = readFileSync(markerPath, "utf8");
    await baseline.setWorkspacePinGroup({
      workspaceId: "ws-corrupt-committed",
      groupId: group.id,
      updatedAt: "2026-08-31T13:00:00.000Z",
    });
    const afterWorkspaceBytes = readFileSync(filePath, "utf8");
    const afterSidecarBytes = readFileSync(sidecarPath, "utf8");
    writeFileSync(
      transactionPath,
      serializedJson(
        pinGroupTransaction({
          phase: "committed",
          beforeWorkspaces: beforeWorkspaceBytes,
          afterWorkspaces: JSON.parse(afterWorkspaceBytes),
          beforePinGroups: beforeSidecarBytes,
          afterPinGroups: JSON.parse(afterSidecarBytes),
          beforePinGroupsBackup: beforeBackupBytes,
          beforeMarker: beforeMarkerBytes,
        }),
      ),
    );
    const corruptPrimaryBytes = "CORRUPT_LATER_PRIMARY_WITH_COMMITTED_JOURNAL";
    writeFileSync(filePath, corruptPrimaryBytes);
    const untouched = {
      primary: readFileSync(filePath, "utf8"),
      sidecar: readFileSync(sidecarPath, "utf8"),
      backup: readFileSync(backupPath, "utf8"),
      marker: readFileSync(markerPath, "utf8"),
      journal: readFileSync(transactionPath, "utf8"),
    };

    const blocked = new FileBackedWorkspaceRegistry(filePath, logger);
    const failure = await blocked.initialize().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(WorkspaceRegistryIntegrityError);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(filePath);
    expect((failure as Error).message).toContain(transactionPath);
    expect((failure as Error).message).toContain("not valid workspace-registry JSON");
    expect(readFileSync(filePath, "utf8")).toBe(untouched.primary);
    expect(readFileSync(sidecarPath, "utf8")).toBe(untouched.sidecar);
    expect(readFileSync(backupPath, "utf8")).toBe(untouched.backup);
    expect(readFileSync(markerPath, "utf8")).toBe(untouched.marker);
    expect(readFileSync(transactionPath, "utf8")).toBe(untouched.journal);

    // Follow the advertised recovery: repair only primary, retain the journal,
    // then let committed recovery validate and converge the complete state.
    writeFileSync(filePath, afterWorkspaceBytes);
    const recovered = new FileBackedWorkspaceRegistry(filePath, logger);
    await recovered.initialize();
    expect(await recovered.get("ws-corrupt-committed")).toMatchObject({
      pinGroupId: group.id,
      pinGroupAssignedAt: "2026-08-31T13:00:00.000Z",
    });
    expect(existsSync(transactionPath)).toBe(false);
  });

  test("creates, renames, lists, and persists pin groups with trimmed names", async () => {
    const filePath = path.join(tmpDir, "projects", "group-workspaces.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_focus",
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await registry.initialize();

    const created = await registry.createPinGroup("  Focus  ");
    expect(created).toEqual({
      id: "pgrp_focus",
      name: "Focus",
      createdAt: "2026-08-31T12:00:00.000Z",
    });
    await expect(registry.createPinGroup("   ")).rejects.toThrow(
      "Pin group name must not be empty",
    );
    expect(await registry.renamePinGroup(created.id, "  This week ")).toEqual({
      ...created,
      name: "This week",
    });
    await expect(
      registry.renamePinGroup(DEFAULT_WORKSPACE_PIN_GROUP_ID, "Favorites"),
    ).rejects.toThrow("The default pin group cannot be renamed");
    await expect(registry.deletePinGroup(DEFAULT_WORKSPACE_PIN_GROUP_ID)).rejects.toThrow(
      "The default pin group cannot be deleted",
    );

    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-preserves-groups",
        projectId: "proj-1",
        cwd: "/tmp/preserves-groups",
        kind: "directory",
        displayName: "preserves-groups",
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:00:00.000Z",
      }),
    );
    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reloaded.initialize();
    expect(await reloaded.listPinGroups()).toEqual([
      {
        id: DEFAULT_WORKSPACE_PIN_GROUP_ID,
        name: "Pinned",
        createdAt: "2026-08-31T12:00:00.000Z",
      },
      { ...created, name: "This week" },
    ]);
  });

  test("writes pinnedAt only for default members and unpins members when deleting a group", async () => {
    const filePath = path.join(tmpDir, "projects", "membership-workspaces.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, logger, {
      pinGroupIdFactory: () => "pgrp_focus",
      now: () => "2026-08-31T12:00:00.000Z",
    });
    await registry.initialize();
    const focus = await registry.createPinGroup("Focus");
    for (const workspaceId of ["ws-default", "ws-focus"]) {
      await registry.upsert(
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId: "proj-1",
          cwd: `/tmp/${workspaceId}`,
          kind: "directory",
          displayName: workspaceId,
          createdAt: "2026-08-31T12:00:00.000Z",
          updatedAt: "2026-08-31T12:00:00.000Z",
        }),
      );
    }

    expect(
      await registry.setWorkspacePinGroup({
        workspaceId: "ws-default",
        groupId: DEFAULT_WORKSPACE_PIN_GROUP_ID,
        updatedAt: "2026-08-31T13:00:00.000Z",
      }),
    ).toMatchObject({
      pinGroupId: DEFAULT_WORKSPACE_PIN_GROUP_ID,
      pinnedAt: "2026-08-31T13:00:00.000Z",
    });
    expect(
      await registry.setWorkspacePinGroup({
        workspaceId: "ws-focus",
        groupId: focus.id,
        updatedAt: "2026-08-31T13:01:00.000Z",
      }),
    ).toMatchObject({
      pinGroupId: focus.id,
      pinGroupAssignedAt: "2026-08-31T13:01:00.000Z",
      pinnedAt: null,
    });
    const reloaded = new FileBackedWorkspaceRegistry(filePath, logger);
    await reloaded.initialize();
    expect(await reloaded.get("ws-focus")).toMatchObject({
      pinGroupId: focus.id,
      pinGroupAssignedAt: "2026-08-31T13:01:00.000Z",
      pinnedAt: null,
    });

    expect(await registry.deletePinGroup(focus.id)).toEqual(["ws-focus"]);
    expect(await registry.get("ws-focus")).toMatchObject({
      pinGroupId: null,
      pinnedAt: null,
      archivedAt: null,
    });
    expect((await registry.listPinGroups()).map((group) => group.id)).toEqual([
      DEFAULT_WORKSPACE_PIN_GROUP_ID,
    ]);
  });
});
