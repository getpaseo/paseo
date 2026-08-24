import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectDirectory,
  ProjectDirectoryRequestError,
  validateDirectoryName,
} from "./project-directory-service.js";

describe("project directory creation", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "paseo-project-directory-"));
    roots.push(root);
    return root;
  }

  it.each(["", "   ", ".", "..", "nested/name", "nested\\name", "/absolute", "C:\\absolute"])(
    "rejects invalid single directory name %j",
    (name) => {
      expect(() => validateDirectoryName(name)).toThrow(ProjectDirectoryRequestError);
    },
  );

  it("requires the selected parent directory to already exist", async () => {
    const root = await createRoot();

    await expect(
      createProjectDirectory(
        { parentPath: join(root, "missing"), name: "project" },
        {
          registerProject: async () => {
            throw new Error("registration should not be attempted");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "parent_directory_not_found" });
  });

  it("does not substitute the daemon cwd for a missing parent selection", async () => {
    await expect(
      createProjectDirectory(
        { parentPath: "  ", name: "project" },
        {
          registerProject: async () => {
            throw new Error("registration should not be attempted");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "parent_directory_not_found",
      message: "Parent directory is required",
    });
  });

  it("rejects collisions without changing the existing directory", async () => {
    const root = await createRoot();
    const existing = join(root, "existing");
    await mkdir(existing);
    let registrationAttempted = false;

    await expect(
      createProjectDirectory(
        { parentPath: root, name: "existing" },
        {
          registerProject: async () => {
            registrationAttempted = true;
            throw new Error("registration should not be attempted");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "directory_exists", directoryPath: existing });
    await expect(access(existing)).resolves.toBeUndefined();
    expect(registrationAttempted).toBe(false);
  });

  it("rolls back the newly created directory when registration fails", async () => {
    const root = await createRoot();
    const directoryPath = join(root, "unregistered");

    await expect(
      createProjectDirectory(
        { parentPath: root, name: "unregistered" },
        {
          registerProject: async () => {
            throw new Error("registry unavailable");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "registration_failed", directoryPath });
    await expect(access(directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the registered project and created path together", async () => {
    const root = await createRoot();
    const directoryPath = join(root, "new-project");
    const project = {
      projectId: `directory:${directoryPath}`,
      rootPath: directoryPath,
      kind: "non_git" as const,
      displayName: "new-project",
      customName: null,
      createdAt: "2026-07-15T10:00:00Z",
      updatedAt: "2026-07-15T10:00:00Z",
      archivedAt: null,
    };

    await expect(
      createProjectDirectory(
        { parentPath: root, name: "new-project" },
        { registerProject: async () => project },
      ),
    ).resolves.toEqual({ directoryPath, project });
    await expect(access(directoryPath)).resolves.toBeUndefined();
  });
});
