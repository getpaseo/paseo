import { describe, expect, test, vi } from "vitest";
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
      get: vi.fn().mockResolvedValue(archivedLegacyProject),
      list: vi.fn().mockResolvedValue([archivedLegacyProject, activeProject]),
    };

    await expect(resolveProjectReference(reference, registry, ["/new/app"])).resolves.toEqual(
      activeProject,
    );
  });
});
