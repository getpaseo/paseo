import { describe, expect, it } from "vitest";
import {
  applyAvailableAddProjectHosts,
  selectableAddProjectHosts,
  failAddProjectSubmission,
  moveAddProjectActiveIndex,
  openAddProjectFlow,
  resolveAddProjectKey,
  selectAddProjectHost,
  selectAddProjectRow,
  selectAddProjectTab,
  setAddProjectLocation,
  setAddProjectQuery,
  setNewFolderName,
  startAddProjectSubmission,
  type AddProjectHost,
} from "./model";
import {
  buildManualGithubRepositoryChoices,
  checkoutName,
  defaultProjectLocation,
  joinDirectoryPath,
  parentDirectory,
  validateNewFolderName,
} from "./options";
import { resolveActiveIndex } from "./tab-view";

const HOST: AddProjectHost = {
  serverId: "host-1",
  label: "Local",
  online: true,
  canAddProject: true,
  canBrowse: true,
  canCloneGithubRepositories: true,
  canSearchGithubRepositories: true,
  canCreateDirectory: true,
};
const REMOTE: AddProjectHost = { ...HOST, serverId: "host-2", label: "Remote", canBrowse: false };
const REMOTE_OFFLINE: AddProjectHost = { ...REMOTE, online: false };

const KEY = { key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe("Add Project flow", () => {
  it("opens on the Existing tab of the preferred host", () => {
    const state = openAddProjectFlow({ hosts: [HOST, REMOTE], preferredHostId: "host-2" });

    expect(state.tab).toBe("existing");
    expect(state.hostId).toBe("host-2");
  });

  it("falls back to the first host, and to no host when none is connected", () => {
    expect(openAddProjectFlow({ hosts: [HOST, REMOTE] }).hostId).toBe("host-1");
    expect(openAddProjectFlow({ hosts: [] }).hostId).toBeNull();
  });

  it("keeps each tab's input when switching tabs", () => {
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = setAddProjectQuery(state, "paseo");
    state = selectAddProjectTab(state, "clone");
    state = setAddProjectQuery(state, "getpaseo/");
    state = selectAddProjectTab(state, "new-folder");
    state = setNewFolderName(state, "acme-api");
    state = selectAddProjectTab(state, "existing");

    expect(state.existing.query).toBe("paseo");
    expect(state.clone.query).toBe("getpaseo/");
    expect(state.newFolder.name).toBe("acme-api");
  });

  it("switching host keeps typed input but drops host-specific locations and selection", () => {
    let state = openAddProjectFlow({ hosts: [HOST, REMOTE] });
    state = setAddProjectQuery(state, "paseo");
    state = selectAddProjectRow(state, "/code/paseo");
    state = selectAddProjectTab(state, "new-folder");
    state = setNewFolderName(state, "acme-api");
    state = setAddProjectLocation(state, "~/work");

    state = selectAddProjectHost(state, "host-2");

    expect(state.hostId).toBe("host-2");
    expect(state.existing).toEqual({ query: "paseo", selectedId: null });
    expect(state.newFolder).toEqual({ name: "acme-api", location: null });
  });

  it("locks tab and host while a submission runs, and unlocks with the failure", () => {
    let state = openAddProjectFlow({ hosts: [HOST, REMOTE] });
    state = selectAddProjectTab(state, "clone");
    state = startAddProjectSubmission(state);

    expect(selectAddProjectTab(state, "existing").tab).toBe("clone");
    expect(selectAddProjectHost(state, "host-2").hostId).toBe("host-1");
    expect(selectAddProjectRow(state, "acme/app")).toBe(state);
    expect(startAddProjectSubmission(state)).toBe(state);

    state = failAddProjectSubmission(state, "Unable to clone project");
    expect(state.submission).toEqual({
      status: "failed",
      tab: "clone",
      message: "Unable to clone project",
    });
    expect(selectAddProjectTab(state, "existing").submission).toEqual({ status: "idle" });
  });

  it("clears a failure once the user edits the input or picks another row", () => {
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = startAddProjectSubmission(state);
    state = failAddProjectSubmission(state, "Directory not found");

    expect(setAddProjectQuery(state, "~/dev").submission).toEqual({ status: "idle" });
    expect(selectAddProjectRow(state, "/code/app").submission).toEqual({ status: "idle" });
  });

  it("keeps the chosen host and its draft while it is offline, never moving them to another host", () => {
    let state = openAddProjectFlow({ hosts: [HOST, REMOTE] });
    state = selectAddProjectHost(state, "host-2");
    state = setAddProjectQuery(state, "/srv/app");

    const offline = applyAvailableAddProjectHosts(state, [HOST, REMOTE_OFFLINE]);
    expect(offline.hostId).toBe("host-2");
    expect(offline.existing.query).toBe("/srv/app");
    expect(selectableAddProjectHosts(offline).map((host) => host.serverId)).toEqual([
      "host-1",
      "host-2",
    ]);

    const back = applyAvailableAddProjectHosts(offline, [HOST, REMOTE]);
    expect(back.hostId).toBe("host-2");
    expect(back.existing.query).toBe("/srv/app");
    expect(selectAddProjectHost(offline, "host-1").hostId).toBe("host-1");
  });

  it("picks only an online host, and another one when the chosen host is removed", () => {
    expect(openAddProjectFlow({ hosts: [REMOTE_OFFLINE, HOST] }).hostId).toBe("host-1");
    expect(
      openAddProjectFlow({ hosts: [REMOTE_OFFLINE, HOST], preferredHostId: "host-2" }).hostId,
    ).toBe("host-1");
    expect(openAddProjectFlow({ hosts: [REMOTE_OFFLINE] }).hostId).toBeNull();
    expect(
      selectAddProjectHost(openAddProjectFlow({ hosts: [HOST, REMOTE_OFFLINE] }), "host-2").hostId,
    ).toBe("host-1");

    const state = selectAddProjectHost(openAddProjectFlow({ hosts: [HOST, REMOTE] }), "host-2");
    expect(applyAvailableAddProjectHosts(state, [HOST]).hostId).toBe("host-1");
    expect(applyAvailableAddProjectHosts(openAddProjectFlow({ hosts: [] }), [REMOTE]).hostId).toBe(
      "host-2",
    );
  });

  it("keeps the user's pick across a reorder and never swaps a dropped pick for another row", () => {
    const rows = [{ id: "/code/beta" }, { id: "/code/alpha" }];
    expect(resolveActiveIndex(rows, "/code/alpha")).toBe(1);
    expect(resolveActiveIndex(rows, null)).toBe(0);
    expect(resolveActiveIndex(rows, "/code/gone")).toBe(-1);
    expect(resolveActiveIndex([], null)).toBe(-1);
  });

  it("wraps keyboard selection at both ends", () => {
    expect(moveAddProjectActiveIndex(2, 3, "next")).toBe(0);
    expect(moveAddProjectActiveIndex(0, 3, "previous")).toBe(2);
  });
});

describe("Add Project keys", () => {
  it("maps Mod+1/2/3 to tabs using the platform's modifier", () => {
    expect(resolveAddProjectKey({ ...KEY, key: "2", metaKey: true }, true)).toEqual({
      kind: "tab",
      tab: "clone",
    });
    expect(resolveAddProjectKey({ ...KEY, key: "3", ctrlKey: true }, false)).toEqual({
      kind: "tab",
      tab: "new-folder",
    });
    expect(resolveAddProjectKey({ ...KEY, key: "1", ctrlKey: true }, true)).toBeNull();
    expect(resolveAddProjectKey({ ...KEY, key: "1" }, true)).toBeNull();
  });

  it("maps arrows and Enter to list commands", () => {
    expect(resolveAddProjectKey({ ...KEY, key: "ArrowDown" }, true)).toEqual({
      kind: "move",
      direction: "next",
    });
    expect(resolveAddProjectKey({ ...KEY, key: "ArrowUp" }, true)).toEqual({
      kind: "move",
      direction: "previous",
    });
    expect(resolveAddProjectKey({ ...KEY, key: "Enter" }, true)).toEqual({ kind: "submit" });
    expect(resolveAddProjectKey({ ...KEY, key: "Enter", shiftKey: true }, true)).toBeNull();
  });
});

describe("Add Project options", () => {
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

  it("defaults the location to a folder that exists", () => {
    expect(defaultProjectLocation({ remembered: undefined, projectPaths: [] })).toBe("~");
    expect(defaultProjectLocation({ remembered: undefined, projectPaths: ["/code/app"] })).toBe(
      "/code",
    );
    expect(defaultProjectLocation({ remembered: "~/work", projectPaths: ["/code/app"] })).toBe(
      "~/work",
    );
  });

  it("keeps a drive or filesystem root when deriving and joining a location", () => {
    expect(parentDirectory("C:\\repo")).toBe("C:\\");
    expect(parentDirectory("/repo")).toBe("/");
    expect(parentDirectory("\\\\nas\\work")).toBeNull();
    expect(parentDirectory("\\\\nas\\work\\app")).toBe("\\\\nas\\work");
    expect(defaultProjectLocation({ remembered: undefined, projectPaths: ["\\\\nas\\work"] })).toBe(
      "~",
    );
    expect(parentDirectory("/code/app")).toBe("/code");
    expect(joinDirectoryPath("C:\\", "new-project")).toBe("C:\\new-project");
    expect(joinDirectoryPath("/", "new-project")).toBe("/new-project");
    expect(defaultProjectLocation({ remembered: undefined, projectPaths: ["C:\\repo"] })).toBe(
      "C:\\",
    );
  });

  it("names the checkout the way the host does", () => {
    expect(checkoutName("acme/app.git")).toBe("app");
    expect(checkoutName("acme/app")).toBe("app");
  });

  it("rejects folder names that are empty or leave the location", () => {
    expect(validateNewFolderName("")).toBe("Enter a folder name");
    expect(validateNewFolderName("..")).toBe("Enter a folder name");
    expect(validateNewFolderName("../invalid")).toBe("Use a name without slashes");
    expect(validateNewFolderName("C:repo")).toBe("Use a name without a drive letter");
    expect(validateNewFolderName(" acme-api ")).toBeNull();
  });
});
