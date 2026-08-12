import { describe, expect, test } from "vitest";
import { DirectorySyncService } from "./index.js";

function project(projectId: string, name: string) {
  return {
    projectId,
    projectDisplayName: name,
    projectRootPath: `/${projectId}`,
    projectKind: "git" as const,
  };
}

describe("DirectorySyncService", () => {
  test("owns one generation and returns latest project changes", () => {
    const service = new DirectorySyncService("generation");
    const initial = service.readProjects([project("one", "One")], {});
    expect(initial).toMatchObject({ mode: "snapshot", headSeq: 1 });

    service.versionProject({ kind: "upsert", project: project("one", "Renamed") });
    service.versionProject({ kind: "upsert", project: project("one", "Latest") });
    expect(
      service.readProjects([project("one", "Latest")], { generation: "generation", afterSeq: 1 }),
    ).toEqual({
      mode: "changes",
      headSeq: 3,
      values: [{ seq: 3, value: project("one", "Latest") }],
      removals: [],
    });
  });

  test("versions a hard project removal once", () => {
    const service = new DirectorySyncService("generation");
    service.readProjects([project("one", "One")], {});
    expect(service.versionProject({ kind: "remove", projectId: "one" })).toEqual({
      generation: "generation",
      seq: 2,
    });
    expect(service.versionProject({ kind: "remove", projectId: "one" })).toEqual({
      generation: "generation",
      seq: 2,
    });
    expect(service.readProjects([], { generation: "generation", afterSeq: 1 }).removals).toEqual([
      { id: "one", seq: 2 },
    ]);
  });

  test("keeps one daemon-wide version for repeated observations", () => {
    const service = new DirectorySyncService("generation");
    const update = { kind: "upsert" as const, project: project("one", "One") };

    expect(service.versionProject(update)).toEqual({ generation: "generation", seq: 1 });
    expect(service.versionProject(update)).toEqual({ generation: "generation", seq: 1 });
  });

  test("falls back to a snapshot when the daemon generation changes", () => {
    const service = new DirectorySyncService("new-generation");
    const read = service.readProjects([project("one", "One")], {
      generation: "old-generation",
      afterSeq: 10,
    });

    expect(read).toMatchObject({ mode: "snapshot", reason: "generation_changed", headSeq: 1 });
  });
});
