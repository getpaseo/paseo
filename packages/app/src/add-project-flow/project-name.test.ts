import { describe, expect, it } from "vitest";
import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  backAddProjectPage,
  currentAddProjectPage,
  openAddProjectFlow,
  openGithubLocationPage,
  openProjectNamePage,
  setAddProjectPageInput,
  type AddProjectHost,
  type GithubRepositoryChoice,
  type ProjectNameTarget,
} from "./model";
import { applyProjectDisplayName, chooseProjectName, projectNamePreview } from "./project-name";

const REPOSITORY: GithubRepositoryChoice = {
  id: "manual:https:vitejs/devtools",
  nameWithOwner: "vitejs/devtools",
  cloneUrl: "vitejs/devtools",
  cloneProtocol: "https",
  description: null,
  updatedAt: null,
};
const CLONE: ProjectNameTarget = { kind: "clone", repository: REPOSITORY, parentPath: "~/dev" };
const DIRECTORY: ProjectNameTarget = { kind: "directory", path: "~/dev/devtools" };

const PROJECT: WorkspaceProjectDescriptorPayload = {
  projectId: "project-1",
  projectDisplayName: "devtools",
  projectCustomName: null,
  projectRootPath: "/home/me/dev/devtools",
  projectKind: "git",
};

const HOST: AddProjectHost = {
  serverId: "host-1",
  label: "Local",
  canAddProject: true,
  canBrowse: true,
  canCloneGithubRepositories: true,
  canNameClonedRepositories: true,
  canSearchGithubRepositories: true,
  canCreateDirectory: true,
};

function createRenameClient() {
  const renames: Array<[string, string | null]> = [];
  return {
    renames,
    renameProject: async (projectId: string, customName: string | null) => {
      renames.push([projectId, customName]);
      return { customName };
    },
  };
}

describe("project name page", () => {
  it("opens prefilled with the default name, edits it, and goes back to the destination", () => {
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openGithubLocationPage(state, HOST.serverId, REPOSITORY);
    state = openProjectNamePage(state, {
      hostId: HOST.serverId,
      target: CLONE,
      defaultName: "devtools",
    });

    expect(currentAddProjectPage(state)).toEqual({
      kind: "project-name",
      hostId: "host-1",
      target: CLONE,
      name: "devtools",
      defaultName: "devtools",
      activeIndex: 0,
      error: null,
      isSubmitting: false,
    });

    state = setAddProjectPageInput(state, "vite-devtools");
    expect(currentAddProjectPage(state)).toMatchObject({ name: "vite-devtools" });

    state = backAddProjectPage(state) ?? state;
    expect(currentAddProjectPage(state).kind).toBe("github-location");
  });
});

describe("chooseProjectName", () => {
  it("keeps the default when the name is empty or unchanged", () => {
    expect(chooseProjectName({ target: CLONE, name: "  ", defaultName: "devtools" })).toEqual({
      kind: "default",
    });
    expect(
      chooseProjectName({ target: CLONE, name: " devtools ", defaultName: "devtools" }),
    ).toEqual({ kind: "default" });
  });

  it("uses a trimmed custom name", () => {
    expect(
      chooseProjectName({ target: CLONE, name: " vite-devtools ", defaultName: "devtools" }),
    ).toEqual({ kind: "custom", name: "vite-devtools" });
  });

  it.each(["vite/devtools", "vite\\devtools", ".", ".."])(
    "rejects %j as a clone folder name",
    (name) => {
      expect(chooseProjectName({ target: CLONE, name, defaultName: "devtools" })).toEqual({
        kind: "invalid",
        error: "Enter a single folder name",
      });
    },
  );

  it("accepts any text as a display name for an existing folder", () => {
    expect(
      chooseProjectName({ target: DIRECTORY, name: "Vite / DevTools", defaultName: "devtools" }),
    ).toEqual({ kind: "custom", name: "Vite / DevTools" });
  });
});

describe("projectNamePreview", () => {
  it("shows the clone destination with the chosen folder name", () => {
    expect(
      projectNamePreview({ target: CLONE, name: "vite-devtools", defaultName: "devtools" }),
    ).toBe("~/dev/vite-devtools");
    expect(projectNamePreview({ target: CLONE, name: "", defaultName: "devtools" })).toBe(
      "~/dev/devtools",
    );
  });

  it("shows the folder being added", () => {
    expect(projectNamePreview({ target: DIRECTORY, name: "Vite", defaultName: "devtools" })).toBe(
      "~/dev/devtools",
    );
  });
});

describe("applyProjectDisplayName", () => {
  it("renames the project to the chosen name", async () => {
    const client = createRenameClient();

    const project = await applyProjectDisplayName({
      client,
      project: PROJECT,
      name: "Vite DevTools",
    });

    expect(client.renames).toEqual([["project-1", "Vite DevTools"]]);
    expect(project).toEqual({
      ...PROJECT,
      projectDisplayName: "Vite DevTools",
      projectCustomName: "Vite DevTools",
    });
  });

  it("does not rename when no name was chosen or the project already has it", async () => {
    const client = createRenameClient();
    const named = { ...PROJECT, projectDisplayName: "Vite DevTools" };

    await expect(applyProjectDisplayName({ client, project: PROJECT, name: null })).resolves.toBe(
      PROJECT,
    );
    await expect(
      applyProjectDisplayName({ client, project: named, name: "Vite DevTools" }),
    ).resolves.toBe(named);
    expect(client.renames).toEqual([]);
  });
});
