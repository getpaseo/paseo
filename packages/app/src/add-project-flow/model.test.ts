import { describe, expect, it } from "vitest";
import {
  applyAvailableAddProjectHosts,
  backAddProjectPage,
  chooseAddProjectHost,
  currentAddProjectPage,
  moveAddProjectActiveIndex,
  moveAddProjectSelection,
  openAddProjectFlow,
  openDirectorySearchPage,
  openGithubLocationPage,
  openNewDirectoryNamePage,
  openNewDirectoryParentPage,
  setAddProjectActiveIndex,
  setAddProjectPageInput,
  setNewDirectoryName,
  type AddProjectHost,
} from "./model";
import {
  addProjectMethodEmptyText,
  buildAddProjectMethods,
  buildCloneLocationOptions,
  buildManualGithubRepositoryChoices,
} from "./options";

const HOST: AddProjectHost = {
  serverId: "host-1",
  label: "Local",
  canAddProject: true,
  canBrowse: true,
  canCloneGithubRepositories: true,
  canSearchGithubRepositories: true,
  canCreateDirectory: true,
};

describe("Add Project navigation", () => {
  it("skips a single connected host without adding it to history", () => {
    const state = openAddProjectFlow({ hosts: [HOST] });

    expect(currentAddProjectPage(state)).toEqual({
      kind: "method",
      hostId: "host-1",
      activeIndex: 0,
      error: null,
      isSubmitting: false,
    });
    expect(backAddProjectPage(state)).toBeNull();
  });

  it("restores page input and selection after Back", () => {
    const secondHost = { ...HOST, serverId: "host-2", label: "Remote" };
    let state = openAddProjectFlow({ hosts: [HOST, secondHost] });
    state = setAddProjectPageInput(state, "rem");
    state = setAddProjectActiveIndex(state, 1);
    state = chooseAddProjectHost(state, { hostId: secondHost.serverId });
    state = openDirectorySearchPage(state, secondHost.serverId);

    state = backAddProjectPage(state) ?? state;
    state = backAddProjectPage(state) ?? state;

    expect(currentAddProjectPage(state)).toEqual({
      kind: "host",
      query: "rem",
      activeIndex: 1,
      error: null,
    });
  });

  it("wraps keyboard selection in both directions", () => {
    expect(moveAddProjectActiveIndex(2, 3, "next")).toBe(0);
    expect(moveAddProjectActiveIndex(0, 3, "previous")).toBe(2);
    expect(moveAddProjectSelection(0, [true, false, true], "next")).toBe(2);
  });

  it("restores a directory name after returning to and reselecting its parent", () => {
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openNewDirectoryParentPage(state, HOST.serverId);
    state = openNewDirectoryNamePage(state, HOST.serverId, "~/dev");
    state = setNewDirectoryName(state, "command-center");
    state = backAddProjectPage(state) ?? state;
    state = openNewDirectoryNamePage(state, HOST.serverId, "~/dev");

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "new-directory-name",
      parentPath: "~/dev",
      name: "command-center",
    });
  });

  it("restores the GitHub destination query and active parent when reopening a repository", () => {
    const repository = {
      id: "repo-1",
      nameWithOwner: "getpaseo/paseo",
      cloneUrl: "git@github.com:getpaseo/paseo.git",
      description: null,
      visibility: "public",
      updatedAt: null,
    };
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openGithubLocationPage(state, HOST.serverId, repository);
    state = setAddProjectPageInput(state, "~/dev");
    state = setAddProjectActiveIndex(state, 2);
    state = backAddProjectPage(state) ?? state;
    state = openGithubLocationPage(state, HOST.serverId, repository);

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "github-location",
      query: "~/dev",
      activeIndex: 2,
    });
  });
});

describe("Add Project opening on directory search", () => {
  const SECOND_HOST: AddProjectHost = { ...HOST, serverId: "host-2", label: "Remote" };

  function pageKinds(state: ReturnType<typeof openAddProjectFlow>): string[] {
    return state.pages.map((page) => page.kind);
  }

  it("keeps the method list as the first page when the preference is off", () => {
    const state = openAddProjectFlow({ hosts: [HOST], startsOnDirectorySearch: false });

    expect(pageKinds(state)).toEqual(["method"]);
  });

  it("opens a single host on directory search above the method list", () => {
    const state = openAddProjectFlow({ hosts: [HOST], startsOnDirectorySearch: true });

    expect(currentAddProjectPage(state)).toEqual({
      kind: "directory-search",
      hostId: "host-1",
      query: "",
      activeIndex: 0,
      error: null,
      isSubmitting: false,
    });
    const methodState = backAddProjectPage(state);
    expect(methodState && currentAddProjectPage(methodState)).toMatchObject({
      kind: "method",
      hostId: "host-1",
    });
    expect(methodState && backAddProjectPage(methodState)).toBeNull();
  });

  it("opens the preferred host on directory search", () => {
    const state = openAddProjectFlow({
      hosts: [HOST, SECOND_HOST],
      preferredHostId: SECOND_HOST.serverId,
      startsOnDirectorySearch: true,
    });

    expect(pageKinds(state)).toEqual(["method", "directory-search"]);
    expect(currentAddProjectPage(state)).toMatchObject({ hostId: "host-2" });
  });

  it("asks for the host first, then lands on directory search with Back to the methods", () => {
    let state = openAddProjectFlow({
      hosts: [HOST, SECOND_HOST],
      startsOnDirectorySearch: true,
    });
    expect(pageKinds(state)).toEqual(["host"]);

    state = chooseAddProjectHost(state, {
      hostId: SECOND_HOST.serverId,
      startsOnDirectorySearch: true,
    });
    expect(pageKinds(state)).toEqual(["host", "method", "directory-search"]);
    expect(currentAddProjectPage(state)).toMatchObject({ hostId: "host-2" });

    state = backAddProjectPage(state) ?? state;
    expect(currentAddProjectPage(state)).toMatchObject({ kind: "method", hostId: "host-2" });
    state = backAddProjectPage(state) ?? state;
    expect(currentAddProjectPage(state).kind).toBe("host");
  });

  it("pushes only the method list for a chosen host when the preference is off", () => {
    let state = openAddProjectFlow({ hosts: [HOST, SECOND_HOST] });

    state = chooseAddProjectHost(state, {
      hostId: SECOND_HOST.serverId,
      startsOnDirectorySearch: false,
    });

    expect(pageKinds(state)).toEqual(["host", "method"]);
  });

  it("lands on directory search when the only host connects after opening", () => {
    let state = openAddProjectFlow({ hosts: [], startsOnDirectorySearch: true });
    expect(pageKinds(state)).toEqual(["host"]);

    state = applyAvailableAddProjectHosts(state, {
      hosts: [HOST],
      startsOnDirectorySearch: true,
    });

    expect(pageKinds(state)).toEqual(["method", "directory-search"]);
  });

  it("lands on the method list when a host connects after opening and the preference is off", () => {
    let state = openAddProjectFlow({ hosts: [] });

    state = applyAvailableAddProjectHosts(state, { hosts: [HOST] });

    expect(pageKinds(state)).toEqual(["method"]);
  });

  it("stays on the method list for a host that cannot add projects", () => {
    const outdatedHost = { ...HOST, canAddProject: false };

    const state = openAddProjectFlow({ hosts: [outdatedHost], startsOnDirectorySearch: true });

    expect(pageKinds(state)).toEqual(["method"]);
  });
});

describe("Add Project options", () => {
  it("hides every mutating method when the host lacks stable project identity", () => {
    const outdatedHost = { ...HOST, canAddProject: false };

    expect(buildAddProjectMethods(outdatedHost)).toEqual([]);
    expect(addProjectMethodEmptyText(outdatedHost)).toBe("Update the host to use Add Project.");
  });

  it("keeps host-upgrade methods discoverable while hiding local-only Browse", () => {
    expect(
      buildAddProjectMethods({
        ...HOST,
        canBrowse: false,
        canCloneGithubRepositories: false,
        canSearchGithubRepositories: false,
        canCreateDirectory: false,
      }),
    ).toEqual([
      {
        id: "directory-search",
        label: "Search for directory",
        description: "Find a directory on Local",
      },
      {
        id: "github",
        label: "Clone from GitHub",
        description: "Update this host to clone GitHub repositories",
        disabled: true,
      },
      {
        id: "new-directory",
        label: "New directory",
        description: "Update this host to create directories",
        disabled: true,
      },
    ]);
  });

  it("offers manual URL and protocol-specific owner/repo clone choices", () => {
    expect(buildManualGithubRepositoryChoices("git@github.com:getpaseo/paseo.git")).toEqual([
      expect.objectContaining({
        id: "manual:git@github.com:getpaseo/paseo.git",
        nameWithOwner: "getpaseo/paseo",
        cloneUrl: "git@github.com:getpaseo/paseo.git",
      }),
    ]);
    expect(buildManualGithubRepositoryChoices("getpaseo/paseo")).toEqual([
      expect.objectContaining({ cloneProtocol: "https", cloneUrl: "getpaseo/paseo" }),
      expect.objectContaining({ cloneProtocol: "ssh", cloneUrl: "getpaseo/paseo" }),
    ]);
    expect(buildManualGithubRepositoryChoices("paseo")).toEqual([]);
  });

  it("shows final clone paths while retaining parent paths as values", () => {
    expect(
      buildCloneLocationOptions({
        parents: ["~/dev", "~/workspace"],
        repositoryName: "paseo",
        existingPaths: ["~/workspace/paseo"],
      }),
    ).toEqual([
      {
        id: "~/dev",
        path: "~/dev",
        displayPath: "~/dev/paseo",
        secondaryText: "Parent directory: ~/dev",
        disabled: false,
      },
      {
        id: "~/workspace",
        path: "~/workspace",
        displayPath: "~/workspace/paseo",
        secondaryText: "Already exists",
        disabled: true,
      },
    ]);
  });

  it("shows equivalent absolute-home and tilde destinations only once", () => {
    expect(
      buildCloneLocationOptions({
        parents: ["/Users/moboudra/dev", "~/dev"],
        repositoryName: "dotfiles",
        existingPaths: [],
      }),
    ).toEqual([
      {
        id: "/Users/moboudra/dev",
        path: "/Users/moboudra/dev",
        displayPath: "/Users/moboudra/dev/dotfiles",
        secondaryText: "Parent directory: /Users/moboudra/dev",
        disabled: false,
      },
    ]);
  });
});
