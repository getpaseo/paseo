import { describe, expect, it } from "vitest";
import {
  backAddProjectPage,
  chooseAddProjectHost,
  currentAddProjectPage,
  moveAddProjectActiveIndex,
  moveAddProjectSelection,
  openAddProjectFlow,
  openGithubLocationPage,
  openNewDirectoryNamePage,
  openNewDirectoryParentPage,
  setAddProjectActiveIndex,
  setAddProjectPageInput,
  setNewDirectoryName,
  type AddProjectHost,
} from "./model";
import {
  buildAddProjectSourceOptions,
  buildCloneLocationOptions,
  buildManualGithubRepositoryChoices,
  canUseGithubSource,
  resolveAddProjectSourceFilter,
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
      kind: "search",
      hostId: "host-1",
      query: "",
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
    state = chooseAddProjectHost(state, secondHost.serverId);
    state = openNewDirectoryParentPage(state, secondHost.serverId);

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

describe("Add Project source filters", () => {
  it("hides the GitHub source when the host cannot clone repositories", () => {
    const outdatedHost = { ...HOST, canAddProject: false };

    expect(canUseGithubSource(outdatedHost)).toBe(false);
    expect(buildAddProjectSourceOptions(outdatedHost)).toEqual([
      { id: "all", label: "All" },
      { id: "local", label: "Local" },
    ]);
  });

  it("offers the GitHub source whenever cloning works, even without account search", () => {
    expect(
      buildAddProjectSourceOptions({
        ...HOST,
        canSearchGithubRepositories: false,
      }),
    ).toEqual([
      { id: "all", label: "All" },
      { id: "local", label: "Local" },
      { id: "github", label: "GitHub" },
    ]);
  });

  it("falls back to All when a stored filter outlives its capability", () => {
    expect(
      resolveAddProjectSourceFilter({ ...HOST, canCloneGithubRepositories: false }, "github"),
    ).toBe("all");
    expect(resolveAddProjectSourceFilter(HOST, "github")).toBe("github");
    expect(resolveAddProjectSourceFilter(HOST, "local")).toBe("local");
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
