import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCreateCommand } from "./create.js";
import { runDeleteCommand } from "./delete.js";
import { createProjectCommand } from "./index.js";
import { runLsCommand } from "./ls.js";
import { resolveProjectName, runRenameCommand } from "./rename.js";

const project = {
  projectId: "project-1",
  projectDisplayName: "Paseo",
  projectCustomName: null,
  projectRootPath: "/tmp/paseo",
  projectKind: "git" as const,
};
const addProject = vi.fn(async () => ({ project, error: null }));
const listProjects = vi.fn(async () => ({ projects: [project] }));
const renameProject = vi.fn(async (_projectId: string, name: string | null) => ({
  customName: name,
}));
const removeProject = vi.fn(async () => ({ removedWorkspaceIds: ["workspace-1"] }));
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  buildDaemonConnectionCommandError: vi.fn(({ error }: { error: unknown }) => error),
  connectToDaemon: vi.fn(async () => ({
    addProject,
    listProjects,
    renameProject,
    removeProject,
    close,
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("project commands", () => {
  it("exposes the complete project lifecycle", () => {
    expect(createProjectCommand().commands.map((command) => command.name())).toEqual([
      "create",
      "ls",
      "rename",
      "delete",
    ]);
  });

  it("creates a project from an absolute directory path", async () => {
    const result = await runCreateCommand("relative/project", {}, {} as never);

    expect(addProject).toHaveBeenCalledWith(path.resolve("relative/project"));
    expect(result.data).toEqual({
      projectId: "project-1",
      name: "Paseo",
      kind: "git",
      path: "/tmp/paseo",
    });
    expect(close).toHaveBeenCalled();
  });

  it("lists projects", async () => {
    const result = await runLsCommand({}, {} as never);

    expect(listProjects).toHaveBeenCalled();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.projectId).toBe("project-1");
  });

  it("renames and resets a project", async () => {
    expect(resolveProjectName({ name: "  New name  " })).toBe("New name");
    expect(resolveProjectName({ reset: true })).toBeNull();

    const result = await runRenameCommand("project-1", "  New name  ", {}, {} as never);
    expect(renameProject).toHaveBeenCalledWith("project-1", "New name");
    expect(result.data).toEqual({ projectId: "project-1", name: "New name" });
  });

  it("rejects an empty project name", () => {
    expect(() => resolveProjectName({ name: "  " })).toThrow();
  });

  it("deletes a project", async () => {
    const result = await runDeleteCommand("project-1", {}, {} as never);

    expect(removeProject).toHaveBeenCalledWith("project-1");
    expect(result.data).toEqual({
      projectId: "project-1",
      removedWorkspaceIds: ["workspace-1"],
    });
  });
});
