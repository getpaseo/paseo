import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { ProviderWorkspace } from "../agent/providers/workspace/index.js";
import type {
  CreateWorkspaceInput,
  WorkspaceRuntimeInspection,
  WorkspaceRuntimePlacement,
} from "../workspace-runtime/index.js";
import { createProviderProbeService } from "./index.js";

const roots: string[] = [];
const posixDescribe = describe.runIf(process.platform !== "win32");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

posixDescribe("provider probe service", () => {
  test("converges concurrent ensures on one deterministic persisted runtime create", async () => {
    const fixture = await createFixture();
    let releaseCreate!: () => void;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    fixture.runtime.create = async (input) => {
      fixture.creates.push(input);
      await createBarrier;
      fixture.inspection = { status: "ready", cwd: fixture.projectRoot };
      await fixture.service.records.persistRuntimeId(input.workspaceId, input.runtimeId, {
        cwd: fixture.projectRoot,
      });
      return placement(input, fixture.projectRoot);
    };

    const first = fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const second = fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    releaseCreate();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.workspaceId).toMatch(/^wksprobe_[a-f0-9]{32}$/u);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.creates[0]).toEqual({
      workspaceId: firstResult.workspaceId,
      runtimeId: "fixture",
      project: {
        id: "project-1",
        source: { kind: "host-directory", path: fixture.projectRoot },
      },
      placement: { kind: "existing" },
      purpose: "provider-probe",
    });
    await expect(fixture.service.records.resolveRuntimeId(firstResult.workspaceId)).resolves.toBe(
      "fixture",
    );
  });

  test("materializes a persisted git source without granting authority to rootPath", async () => {
    const fixture = await createFixture({
      projectSource: {
        kind: "git",
        url: "https://example.test/acme/project.git",
        revision: "release",
        subdirectory: "packages/app",
      },
    });

    await fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });

    expect(fixture.creates[0]?.project.source).toEqual({
      kind: "git",
      url: "https://example.test/acme/project.git",
      revision: "release",
      subdirectory: "packages/app",
    });
    expect(JSON.stringify(fixture.creates[0]?.project.source)).not.toContain(fixture.projectRoot);
  });

  test("reuses persisted ready identity and resolves only probe provider workspaces", async () => {
    const first = await createFixture();
    const ensured = await first.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const providerWorkspace = await first.service.resolveProviderWorkspace(ensured.workspaceId);
    const reopened = createService(first);

    first.inspection = { status: "ready", cwd: first.projectRoot };
    await expect(
      reopened.ensure({ projectId: "project-1", runtimeId: "fixture" }),
    ).resolves.toEqual(ensured);
    expect(first.creates).toHaveLength(1);
    await expect(reopened.resolveProviderWorkspace(ensured.workspaceId)).resolves.toBe(
      providerWorkspace,
    );
    await expect(reopened.resolveProviderWorkspace("ordinary-workspace")).resolves.toBeNull();
  });

  test("removes a failed materialization so an explicit retry can create again", async () => {
    const fixture = await createFixture();
    fixture.runtime.create = async (input) => {
      fixture.creates.push(input);
      if (fixture.creates.length === 1) throw new Error("fixture materialization failed");
      fixture.inspection = { status: "ready", cwd: fixture.projectRoot };
      await fixture.service.records.persistRuntimeId(input.workspaceId, input.runtimeId, {
        cwd: fixture.projectRoot,
      });
      return placement(input, fixture.projectRoot);
    };

    await expect(
      fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" }),
    ).rejects.toThrow("fixture materialization failed");
    await expect(
      fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" }),
    ).resolves.toMatchObject({ workspaceId: expect.stringMatching(/^wksprobe_/u) });
    expect(fixture.creates).toHaveLength(2);
  });

  test("recreation replaces a persisted stale fingerprint with the freshly computed value", async () => {
    const fixture = await createFixture();
    const ensured = await fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const recordsPath = path.join(fixture.root, "provider-probes.json");
    const [record] = JSON.parse(await readFile(recordsPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    await writeFile(
      recordsPath,
      `${JSON.stringify([{ ...record, fingerprint: "stale", status: "materializing" }], null, 2)}\n`,
    );
    fixture.inspection = { status: "missing" };
    const reopened = createService(fixture);
    fixture.service = reopened;

    await reopened.ensure({ projectId: "project-1", runtimeId: "fixture" });

    const [recreated] = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
      workspaceId: string;
      fingerprint: string;
    }>;
    expect(recreated.workspaceId).toBe(ensured.workspaceId);
    expect(recreated.fingerprint).not.toBe("stale");
  });

  test("pauses after the idle TTL and resumes on the next ensure without rotating the provider binding", async () => {
    const fixture = await createFixture();
    const ensured = await fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const firstBinding = await fixture.service.resolveProviderWorkspace(ensured.workspaceId);

    await fixture.clock.advanceBy(30 * 60_000);

    expect(fixture.pauses).toEqual([ensured.workspaceId]);
    expect(fixture.inspection.status).toBe("paused");
    await expect(fixture.service.resolveProviderWorkspace(ensured.workspaceId)).resolves.toBeNull();

    await expect(
      fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" }),
    ).resolves.toEqual(ensured);
    expect(fixture.resumes).toEqual([ensured.workspaceId]);
    await expect(fixture.service.resolveProviderWorkspace(ensured.workspaceId)).resolves.toBe(
      firstBinding,
    );
  });

  test("destroys and recreates when the committed project source changes", async () => {
    const fixture = await createFixture({ gitProject: true });
    const first = await fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const firstBinding = await fixture.service.resolveProviderWorkspace(first.workspaceId);

    await writeFile(path.join(fixture.projectRoot, "source.txt"), "v2\n");
    execFileSync("git", ["add", "source.txt"], { cwd: fixture.projectRoot });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "v2"], {
      cwd: fixture.projectRoot,
    });

    await expect(
      fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" }),
    ).resolves.toEqual(first);
    expect(fixture.destroys).toEqual([first.workspaceId]);
    expect(fixture.creates).toHaveLength(2);
    await expect(fixture.service.resolveProviderWorkspace(first.workspaceId)).resolves.not.toBe(
      firstBinding,
    );
  });

  test("destroys and recreates when runtime configuration changes", async () => {
    const fixture = await createFixture();
    const first = await fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const reconfigured = createService(fixture, {
      fixture: { type: "command", options: { sentinel: false } },
    });
    fixture.service = reconfigured;

    await expect(
      reconfigured.ensure({ projectId: "project-1", runtimeId: "fixture" }),
    ).resolves.toEqual(first);
    expect(fixture.destroys).toEqual([first.workspaceId]);
    expect(fixture.creates).toHaveLength(2);
  });

  test("startup reconcile pauses valid probes and destroys stale, interrupted, and orphaned probes", async () => {
    const fixture = await createFixture();
    const valid = await fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const recordsPath = path.join(fixture.root, "provider-probes.json");
    const [validRecord] = JSON.parse(await readFile(recordsPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    const oldTimestamp = "2026-07-01T00:00:00.000Z";
    await writeFile(
      recordsPath,
      `${JSON.stringify(
        [
          validRecord,
          {
            ...validRecord,
            workspaceId: "wksprobe_old",
            projectId: "project-1",
            lastUsedAt: oldTimestamp,
            createdAt: oldTimestamp,
          },
          {
            ...validRecord,
            workspaceId: "wksprobe_interrupted",
            status: "destroying",
          },
          {
            ...validRecord,
            workspaceId: "wksprobe_materializing_ready",
            status: "materializing",
          },
          {
            ...validRecord,
            workspaceId: "wksprobe_materializing_missing",
            status: "materializing",
          },
          {
            ...validRecord,
            workspaceId: "wksprobe_orphan",
            projectId: "missing-project",
          },
        ],
        null,
        2,
      )}\n`,
    );
    fixture.inspections.set(valid.workspaceId, { status: "ready", cwd: fixture.projectRoot });
    fixture.inspections.set("wksprobe_old", { status: "paused", cwd: fixture.projectRoot });
    fixture.inspections.set("wksprobe_interrupted", { status: "missing" });
    fixture.inspections.set("wksprobe_materializing_ready", {
      status: "ready",
      cwd: fixture.projectRoot,
    });
    fixture.inspections.set("wksprobe_materializing_missing", { status: "missing" });
    fixture.inspections.set("wksprobe_orphan", { status: "ready", cwd: fixture.projectRoot });
    const restarted = createService(fixture);
    fixture.service = restarted;

    await restarted.reconcile();

    expect(fixture.pauses).toContain(valid.workspaceId);
    expect(fixture.destroys).toEqual(
      expect.arrayContaining([
        "wksprobe_old",
        "wksprobe_interrupted",
        "wksprobe_materializing_missing",
        "wksprobe_orphan",
      ]),
    );
    const remaining = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
      workspaceId: string;
      status: string;
    }>;
    expect(remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: valid.workspaceId, status: "paused" }),
        expect.objectContaining({
          workspaceId: "wksprobe_materializing_ready",
          status: "paused",
        }),
      ]),
    );
    expect(remaining).toHaveLength(2);
  });

  test("project invalidation converges with concurrent ensure and removes the runtime record", async () => {
    const fixture = await createFixture();
    let releaseCreate!: () => void;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const originalCreate = fixture.runtime.create;
    fixture.runtime.create = async (input) => {
      await createBarrier;
      return originalCreate(input);
    };

    const ensure = fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const invalidations = Promise.all([
      fixture.service.invalidateProject("project-1"),
      fixture.service.invalidateProject("project-1"),
    ]);
    releaseCreate();
    const ensured = await ensure;
    await invalidations;

    expect(fixture.destroys).toEqual([ensured.workspaceId]);
    await expect(fixture.service.records.resolveRuntimeId(ensured.workspaceId)).resolves.toBeNull();
  });

  test("rejects invalid persisted lifecycle timestamps at the store boundary", async () => {
    const fixture = await createFixture();
    await writeFile(
      path.join(fixture.root, "invalid-provider-probes.json"),
      `${JSON.stringify([
        {
          workspaceId: "wksprobe_invalid",
          projectId: "project-1",
          runtimeId: "fixture",
          fingerprint: "fingerprint",
          status: "paused",
          lastUsedAt: "yesterday-ish",
          createdAt: "2026-08-12T00:00:00.000Z",
        },
      ])}\n`,
    );
    const invalid = createProviderProbeService({
      filePath: path.join(fixture.root, "invalid-provider-probes.json"),
      logger: pino({ enabled: false }),
      projects: { get: async () => null },
      runtime: fixture.runtime,
      clock: fixture.clock,
      bindWorkspaceProviderCapability: async () => ({ cwd: "." }) as ProviderWorkspace,
    });

    await expect(invalid.reconcile()).rejects.toThrow();
  });
});

async function createFixture(
  options: {
    gitProject?: boolean;
    projectSource?: {
      kind: "git";
      url: string;
      revision?: string;
      subdirectory?: string;
    };
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-provider-probe-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  if (options.gitProject) {
    execFileSync("git", ["init", "-b", "main"], { cwd: projectRoot });
    execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: projectRoot });
    execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: projectRoot });
    await writeFile(path.join(projectRoot, "source.txt"), "v1\n");
    execFileSync("git", ["add", "source.txt"], { cwd: projectRoot });
    execFileSync("git", ["commit", "-m", "v1"], { cwd: projectRoot });
  }
  let inspection: WorkspaceRuntimeInspection = { status: "missing" };
  const inspections = new Map<string, WorkspaceRuntimeInspection>();
  const creates: CreateWorkspaceInput[] = [];
  const pauses: string[] = [];
  const resumes: string[] = [];
  const destroys: string[] = [];
  const providerWorkspaces = new Map<string, ProviderWorkspace>();
  const clock = new TestClock(Date.parse("2026-08-12T00:00:00.000Z"));
  let service: ReturnType<typeof createProviderProbeService>;
  const runtime = {
    create: async (input: CreateWorkspaceInput) => {
      creates.push(input);
      inspection = { status: "ready", cwd: projectRoot };
      inspections.set(input.workspaceId, inspection);
      await service.records.persistRuntimeId(input.workspaceId, input.runtimeId, {
        cwd: projectRoot,
      });
      return placement(input, projectRoot);
    },
    inspect: async (workspaceId: string) => inspections.get(workspaceId) ?? inspection,
    pause: async (workspaceId: string) => {
      pauses.push(workspaceId);
      inspection = { status: "paused", cwd: projectRoot };
      inspections.set(workspaceId, inspection);
    },
    resume: async (workspaceId: string) => {
      resumes.push(workspaceId);
      inspection = { status: "ready", cwd: projectRoot };
      inspections.set(workspaceId, inspection);
    },
    destroy: async (workspaceId: string) => {
      destroys.push(workspaceId);
      inspection = { status: "missing" };
      inspections.set(workspaceId, inspection);
      await service.records.beginWorkspaceDeletion?.(workspaceId);
      await service.records.removeWorkspaceRecord?.(workspaceId);
      providerWorkspaces.delete(workspaceId);
    },
    listRuntimes: () => [{ runtimeId: "fixture", builtin: false, requiresGitProject: false }],
  };
  const fixture = {
    root,
    projectRoot,
    creates,
    pauses,
    resumes,
    destroys,
    inspections,
    providerWorkspaces,
    clock,
    runtime,
    projectSource: options.projectSource,
    get inspection() {
      return inspection;
    },
    set inspection(value: WorkspaceRuntimeInspection) {
      inspection = value;
    },
    get service() {
      return service;
    },
    set service(value: ReturnType<typeof createProviderProbeService>) {
      service = value;
    },
  };
  service = createService(fixture);
  fixture.service = service;
  return fixture;
}

function createService(
  fixture: {
    root: string;
    projectRoot: string;
    providerWorkspaces: Map<string, ProviderWorkspace>;
    clock: TestClock;
    runtime: {
      create(input: CreateWorkspaceInput): Promise<WorkspaceRuntimePlacement>;
      inspect(workspaceId: string): Promise<WorkspaceRuntimeInspection>;
      pause(workspaceId: string): Promise<void>;
      resume(workspaceId: string): Promise<void>;
      destroy(workspaceId: string): Promise<void>;
      listRuntimes(): readonly {
        runtimeId: string;
        builtin: boolean;
        requiresGitProject: boolean;
      }[];
    };
    projectSource?: {
      kind: "git";
      url: string;
      revision?: string;
      subdirectory?: string;
    };
  },
  runtimeConfiguration: Readonly<Record<string, unknown>> = {
    fixture: { type: "command", options: { sentinel: true } },
  },
) {
  return createProviderProbeService({
    filePath: path.join(fixture.root, "provider-probes.json"),
    logger: pino({ enabled: false }),
    projects: {
      get: async (projectId: string) =>
        projectId === "project-1"
          ? {
              projectId,
              rootPath: fixture.projectRoot,
              source: fixture.projectSource,
              updatedAt: "2026-08-12T00:00:00.000Z",
              archivedAt: null,
            }
          : null,
    },
    runtime: fixture.runtime,
    clock: fixture.clock,
    runtimeConfiguration,
    bindWorkspaceProviderCapability: async (workspaceId) => {
      let workspace = fixture.providerWorkspaces.get(workspaceId);
      if (!workspace) {
        workspace = { cwd: "." } as ProviderWorkspace;
        fixture.providerWorkspaces.set(workspaceId, workspace);
      }
      return workspace;
    },
  });
}

function placement(input: CreateWorkspaceInput, cwd: string): WorkspaceRuntimePlacement {
  return { workspaceId: input.workspaceId, runtimeId: input.runtimeId, cwd };
}

interface TestTimer {
  callback: () => void | Promise<void>;
  at: number;
  cleared: boolean;
}

class TestClock {
  private readonly timers: TestTimer[] = [];

  constructor(private time: number) {}

  now = (): Date => new Date(this.time);

  setTimeout = (callback: () => void | Promise<void>, delayMs: number): TestTimer => {
    const timer = { callback, at: this.time + delayMs, cleared: false };
    this.timers.push(timer);
    return timer;
  };

  clearTimeout = (timer: TestTimer): void => {
    timer.cleared = true;
  };

  async advanceBy(milliseconds: number): Promise<void> {
    const end = this.time + milliseconds;
    while (true) {
      const timer = this.timers
        .filter((candidate) => !candidate.cleared && candidate.at <= end)
        .sort((left, right) => left.at - right.at)[0];
      if (!timer) break;
      timer.cleared = true;
      this.time = timer.at;
      await timer.callback();
    }
    this.time = end;
  }
}
