import { describe, expect, test } from "vitest";
import type { PersistedProjectRecord } from "./workspace-registry.js";
import { resolveProjectReference } from "./project-reference.js";

function project(input: {
  projectId: string;
  projectKey: string;
  rootPath: string;
  archivedAt?: string | null;
}): PersistedProjectRecord {
  return {
    projectId: input.projectId,
    projectKey: input.projectKey,
    rootPath: input.rootPath,
    kind: "git",
    displayName: "acme/app",
    customName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
  };
}

describe("resolveProjectReference", () => {
  test("resolves an active opaque project when an archived legacy project owns the direct id", async () => {
    const reference = "remote:github.com/acme/app";
    const archivedLegacyProject = project({
      projectId: reference,
      projectKey: reference,
      rootPath: "/old/app",
      archivedAt: "2026-02-01T00:00:00.000Z",
    });
    const activeProject = project({
      projectId: "opaque-project-id",
      projectKey: reference,
      rootPath: "/new/app",
    });
    const registry = {
      get: async () => archivedLegacyProject,
      list: async () => [archivedLegacyProject, activeProject],
    };

    await expect(resolveProjectReference(reference, registry, ["/new/app"])).resolves.toEqual(
      activeProject,
    );
  });

  test("preserves an archived direct project when there is no active replacement", async () => {
    const archivedProject = project({
      projectId: "archived-project-id",
      projectKey: "remote:github.com/acme/app",
      rootPath: "/old/app",
      archivedAt: "2026-02-01T00:00:00.000Z",
    });
    const registry = {
      get: async () => archivedProject,
      list: async () => [archivedProject],
    };

    await expect(resolveProjectReference(archivedProject.projectId, registry)).resolves.toEqual(
      archivedProject,
    );
  });

  test("rejects a legacy alias when its path hint contradicts the remaining clone", async () => {
    const reference = "remote:github.com/acme/app";
    const remainingClone = project({
      projectId: "opaque-project-id",
      projectKey: reference,
      rootPath: "/repos/remaining-clone",
    });
    const registry = {
      get: async () => null,
      list: async () => [remainingClone],
    };

    await expect(
      resolveProjectReference(reference, registry, ["/repos/removed-clone"]),
    ).resolves.toBeNull();
  });
});
