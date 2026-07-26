import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { setCustomProjectIcon } from "../../../utils/project-icon.js";
import {
  createPersistedProjectRecord,
  type PersistedProjectRecord,
  type ProjectRegistry,
} from "../../workspace-registry.js";
import { PortableConfigService } from "./portable-config-service.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory(label: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  tempDirectories.push(directory);
  return directory;
}

class MemoryProjectRegistry implements ProjectRegistry {
  private records = new Map<string, PersistedProjectRecord>();
  private nextId = 1;

  constructor(records: PersistedProjectRecord[] = []) {
    for (const record of records) this.records.set(record.projectId, record);
  }

  async initialize() {}
  async existsOnDisk() {
    return false;
  }
  async list() {
    return Array.from(this.records.values());
  }
  async get(projectId: string) {
    return this.records.get(projectId) ?? null;
  }
  async getOrCreateActiveByRoot(input: {
    rootPath: string;
    kind: "git" | "non_git";
    displayName: string;
    timestamp: string;
  }) {
    const existing = Array.from(this.records.values()).find(
      (record) => !record.archivedAt && record.rootPath === input.rootPath,
    );
    if (existing) return existing;
    const record = createPersistedProjectRecord({
      projectId: `generated-${this.nextId++}`,
      rootPath: input.rootPath,
      kind: input.kind,
      displayName: input.displayName,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    });
    this.records.set(record.projectId, record);
    return record;
  }
  async upsert(record: PersistedProjectRecord) {
    this.records.set(record.projectId, record);
  }
  async archive(projectId: string, archivedAt: string) {
    const record = this.records.get(projectId);
    if (record) this.records.set(projectId, { ...record, archivedAt });
  }
  async remove(projectId: string) {
    this.records.delete(projectId);
  }
}

function project(input: {
  projectId: string;
  rootPath: string;
  displayName?: string;
  customName?: string | null;
  archivedAt?: string | null;
}): PersistedProjectRecord {
  return createPersistedProjectRecord({
    projectId: input.projectId,
    rootPath: input.rootPath,
    kind: "git",
    displayName: input.displayName ?? input.projectId,
    customName: input.customName,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt,
  });
}

describe("PortableConfigService", () => {
  test("exports active projects with home-relative paths and custom icons", async () => {
    const homeDirectory = makeTempDirectory("portable-config-home");
    const paseoHome = makeTempDirectory("portable-config-paseo");
    const activeRoot = join(homeDirectory, "code", "client", "repo");
    const archivedRoot = join(homeDirectory, "code", "old");
    const registry = new MemoryProjectRegistry([
      project({
        projectId: "project-1",
        rootPath: activeRoot,
        displayName: "client/repo",
        customName: "Billing",
      }),
      project({
        projectId: "project-2",
        rootPath: archivedRoot,
        archivedAt: "2026-02-01T00:00:00.000Z",
      }),
    ]);
    await setCustomProjectIcon(paseoHome, activeRoot, { emoji: "\u{1F4B2}" });

    const backup = await new PortableConfigService({
      paseoHome,
      projectRegistry: registry,
      homeDirectory,
      now: () => "2026-07-26T10:00:00.000Z",
    }).export();

    expect(backup).toMatchObject({
      version: 1,
      exportedAt: "2026-07-26T10:00:00.000Z",
      projects: [
        {
          projectId: "project-1",
          rootPath: activeRoot,
          homeRelativePath: "code/client/repo",
          displayName: "client/repo",
          customName: "Billing",
          customIcon: { kind: "emoji", emoji: "\u{1F4B2}" },
        },
      ],
    });
  });

  test("restores under the new home directory and preserves project identity", async () => {
    const paseoHome = makeTempDirectory("portable-config-restore");
    const newHome = "/Users/new";
    const restoredRoot = "/Users/new/code/client/repo";
    const registry = new MemoryProjectRegistry();
    const service = new PortableConfigService({
      paseoHome,
      projectRegistry: registry,
      homeDirectory: newHome,
      now: () => "2026-07-26T11:00:00.000Z",
      directoryExists: async (path) => path === restoredRoot,
    });

    const result = await service.import({
      version: 1,
      exportedAt: "2026-07-26T10:00:00.000Z",
      projects: [
        {
          projectId: "project-1",
          rootPath: "/Users/old/code/client/repo",
          homeRelativePath: "code/client/repo",
          kind: "git",
          displayName: "client/repo",
          customName: "Billing",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          customIcon: { kind: "emoji", emoji: "\u{1F4B2}" },
        },
      ],
    });

    expect(result).toMatchObject({
      added: 1,
      updated: 0,
      skipped: 0,
      projectIdMap: { "project-1": "project-1" },
      rootPathMap: { "/Users/old/code/client/repo": restoredRoot },
    });
    expect(await registry.get("project-1")).toMatchObject({
      rootPath: restoredRoot,
      customName: "Billing",
      archivedAt: null,
    });
  });

  test("remaps an imported id collision instead of overwriting the existing project", async () => {
    const paseoHome = makeTempDirectory("portable-config-collision");
    const existing = project({ projectId: "project-1", rootPath: "/code/existing" });
    const registry = new MemoryProjectRegistry([existing]);
    const service = new PortableConfigService({
      paseoHome,
      projectRegistry: registry,
      directoryExists: async (path) => path === "/code/imported",
    });

    const result = await service.import({
      version: 1,
      exportedAt: "2026-07-26T10:00:00.000Z",
      projects: [
        {
          projectId: "project-1",
          rootPath: "/code/imported",
          kind: "git",
          displayName: "imported",
          customName: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          customIcon: null,
        },
      ],
    });

    expect(result.projectIdMap).toEqual({ "project-1": "generated-1" });
    expect((await registry.get("project-1"))?.rootPath).toBe("/code/existing");
    expect((await registry.get("generated-1"))?.rootPath).toBe("/code/imported");
  });

  test("skips project paths that do not exist", async () => {
    const service = new PortableConfigService({
      paseoHome: makeTempDirectory("portable-config-missing"),
      projectRegistry: new MemoryProjectRegistry(),
      directoryExists: async () => false,
    });

    const result = await service.import({
      version: 1,
      exportedAt: "2026-07-26T10:00:00.000Z",
      projects: [
        {
          projectId: "missing",
          rootPath: "/missing",
          kind: "non_git",
          displayName: "missing",
          customName: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          customIcon: null,
        },
      ],
    });

    expect(result.skipped).toBe(1);
    expect(result.skippedProjects[0]).toMatchObject({
      projectId: "missing",
      rootPath: "/missing",
    });
  });
});
