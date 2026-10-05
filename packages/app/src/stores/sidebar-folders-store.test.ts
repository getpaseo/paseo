import { describe, expect, it } from "vitest";
import {
  assignProjectToSidebarFolder,
  createSidebarFolder,
  deleteSidebarFolder,
  moveSidebarFolder,
  reconcileSidebarFolderAssignments,
  renameSidebarFolder,
  resolveSidebarProjectFolderId,
  toggleSidebarFolderCollapsed,
  type SidebarFolderProject,
  type SidebarFoldersState,
} from "./sidebar-folders-store";

/** `hostRefs` are `serverId:projectId`. */
function projectOn(viewKey: string, hostRefs: string[]): SidebarFolderProject {
  return {
    viewKey,
    hosts: hostRefs.map((ref) => {
      const [serverId = "", projectId = ""] = ref.split(":");
      return { serverId, projectId };
    }),
  };
}

const empty: SidebarFoldersState = {
  folders: [],
  projectAssignments: [],
  collapsedFolderIds: [],
};

function withFolders(): SidebarFoldersState {
  let state = createSidebarFolder(empty, { id: "work", name: " Work " });
  state = createSidebarFolder(state, { id: "personal", name: "Personal" });
  return state;
}

describe("sidebar folders", () => {
  it("creates folders with trimmed names and ignores blank names", () => {
    const state = withFolders();
    expect(state.folders).toEqual([
      { id: "work", name: "Work" },
      { id: "personal", name: "Personal" },
    ]);
    expect(createSidebarFolder(state, { id: "blank", name: "   " })).toBe(state);
  });

  it("renames a folder but keeps the old name for a blank one", () => {
    const state = renameSidebarFolder(withFolders(), "work", "Clients");
    expect(state.folders[0]).toEqual({ id: "work", name: "Clients" });
    expect(renameSidebarFolder(state, "work", " ")).toBe(state);
  });

  it("assigns a project to a folder that exists; null or a missing folder moves it to the root", () => {
    const project = projectOn("repo", ["a:prj_1", "b:prj_2"]);
    let state = assignProjectToSidebarFolder(withFolders(), project, "work");
    expect(state.projectAssignments).toEqual([
      { folderId: "work", refs: ["a:prj_1", "b:prj_2", "view:repo"] },
    ]);
    expect(resolveSidebarProjectFolderId(state, project)).toBe("work");
    state = assignProjectToSidebarFolder(state, project, "missing");
    expect(state.projectAssignments).toEqual([]);
    state = assignProjectToSidebarFolder(state, project, "personal");
    state = assignProjectToSidebarFolder(state, project, null);
    expect(state.projectAssignments).toEqual([]);
  });

  it("keeps the folder when a project joins another host and then leaves the first", () => {
    let state = assignProjectToSidebarFolder(withFolders(), projectOn("repo", ["a:prj_1"]), "work");
    state = reconcileSidebarFolderAssignments(state, [projectOn("repo", ["a:prj_1", "b:prj_9"])]);
    // Host a is gone, and the view key changed with a new remote: only b's ref is left to match.
    expect(resolveSidebarProjectFolderId(state, projectOn("new-remote", ["b:prj_9"]))).toBe("work");
  });

  it("keeps the folder when the view key changes and later the host does too", () => {
    let state = assignProjectToSidebarFolder(withFolders(), projectOn("repo", ["a:prj_1"]), "work");
    state = reconcileSidebarFolderAssignments(state, [projectOn("new-remote", ["a:prj_1"])]);
    expect(resolveSidebarProjectFolderId(state, projectOn("new-remote", ["b:prj_9"]))).toBe("work");
  });

  it("moving a project drops refs from hosts and remotes it left, so they cannot pull it back", () => {
    let state = assignProjectToSidebarFolder(withFolders(), projectOn("repo", ["a:prj_1"]), "work");
    state = reconcileSidebarFolderAssignments(state, [projectOn("repo", ["a:prj_1", "b:prj_9"])]);
    // Host a and the old remote are gone; the user moves the project from what is left of it.
    const moved = assignProjectToSidebarFolder(
      state,
      projectOn("new-remote", ["b:prj_9"]),
      "personal",
    );
    const cleared = assignProjectToSidebarFolder(state, projectOn("new-remote", ["b:prj_9"]), null);
    const oldHostBack = projectOn("repo", ["a:prj_1"]);
    expect(resolveSidebarProjectFolderId(moved, oldHostBack)).toBe("personal");
    expect(resolveSidebarProjectFolderId(cleared, oldHostBack)).toBeNull();
  });

  it("reconcile returns the same state when nothing is missing", () => {
    const project = projectOn("repo", ["a:prj_1"]);
    const state = assignProjectToSidebarFolder(withFolders(), project, "work");
    expect(reconcileSidebarFolderAssignments(state, [project, projectOn("other", ["a:x"])])).toBe(
      state,
    );
  });

  it("deleting a folder returns its projects to the root", () => {
    let state = assignProjectToSidebarFolder(withFolders(), projectOn("a", ["s:a"]), "work");
    state = assignProjectToSidebarFolder(state, projectOn("b", ["s:b"]), "personal");
    state = toggleSidebarFolderCollapsed(state, "work");
    state = deleteSidebarFolder(state, "work");
    expect(state.folders.map((folder) => folder.id)).toEqual(["personal"]);
    expect(state.projectAssignments).toEqual([{ folderId: "personal", refs: ["s:b", "view:b"] }]);
    expect(state.collapsedFolderIds).toEqual([]);
  });

  it("moves folders within bounds", () => {
    const state = withFolders();
    expect(moveSidebarFolder(state, "personal", -1).folders.map((folder) => folder.id)).toEqual([
      "personal",
      "work",
    ]);
    expect(moveSidebarFolder(state, "work", -1)).toBe(state);
    expect(moveSidebarFolder(state, "personal", 1)).toBe(state);
  });

  it("toggles collapse", () => {
    const collapsed = toggleSidebarFolderCollapsed(withFolders(), "work");
    expect(collapsed.collapsedFolderIds).toEqual(["work"]);
    expect(toggleSidebarFolderCollapsed(collapsed, "work").collapsedFolderIds).toEqual([]);
  });
});
