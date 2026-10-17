// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type { HostProjectListItem } from "@/projects/host-projects";
import {
  buildFolderPickerComboboxOptions,
  dispatchProjectPickerSelect,
  folderAwareShowRefPicker,
  folderOptionId,
  folderPickerEmptyText,
  pathFromFolderOptionId,
  resolveFolderAwareWorktreeSupport,
  resolveFolderPickerQueryEnabled,
  resolveFolderTargetView,
  resolveInitialFolderTarget,
  resolveProjectPickerPresentation,
  useNewWorkspaceFolderTarget,
} from "./folder-picker";

const t = ((key: string, options?: { path?: string }) =>
  options?.path ? `${key} ${options.path}` : key) as TFunction;

function project(input: { projectKey: string; serverId?: string }): HostProjectListItem {
  const serverId = input.serverId ?? "host";
  return {
    viewKey: `view:${serverId}:${input.projectKey}`,
    projectKey: input.projectKey,
    projectName: input.projectKey,
    projectKind: "git",
    iconWorkingDir: `/work/${input.projectKey}`,
    hosts: [
      {
        serverId,
        projectId: input.projectKey,
        iconWorkingDir: `/work/${input.projectKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaceKeys: [],
  };
}

describe("resolveInitialFolderTarget", () => {
  it("returns the directory when no projectId is set", () => {
    expect(resolveInitialFolderTarget({ sourceDirectory: "/tmp/work" })).toBe("/tmp/work");
  });

  it("returns null when a projectId is set", () => {
    expect(
      resolveInitialFolderTarget({ sourceDirectory: "/tmp/work", projectId: "proj-1" }),
    ).toBeNull();
  });

  it("returns null for empty or missing directories", () => {
    expect(resolveInitialFolderTarget({})).toBeNull();
    expect(resolveInitialFolderTarget({ sourceDirectory: "   " })).toBeNull();
  });
});

describe("folder option ids", () => {
  it("round-trips a path through the option id", () => {
    const id = folderOptionId("/tmp/some dir");
    expect(pathFromFolderOptionId(id)).toBe("/tmp/some dir");
  });

  it("returns null for non-folder ids", () => {
    expect(pathFromFolderOptionId("proj:abc")).toBeNull();
  });
});

describe("buildFolderPickerComboboxOptions", () => {
  it("prefixes suggestion option ids with the folder prefix", () => {
    const options = buildFolderPickerComboboxOptions({
      serverPaths: ["/home/user/work/repo"],
      query: "repo",
      t,
    });
    expect(options).toEqual([
      {
        id: "dir:/home/user/work/repo",
        label: "~/work/repo",
        description: "/home/user/work/repo",
      },
    ]);
  });

  it("prepends a use-path option for an arbitrary absolute path query", () => {
    const options = buildFolderPickerComboboxOptions({
      serverPaths: [],
      query: "/opt/custom/dir",
      t,
    });
    expect(options[0]).toEqual({
      id: "dir:/opt/custom/dir",
      label: "newWorkspace.folderPicker.usePath /opt/custom/dir",
      description: "newWorkspace.folderPicker.openPath",
    });
  });

  it("does not add a use-path option for non-path queries", () => {
    const options = buildFolderPickerComboboxOptions({
      serverPaths: [],
      query: "documents",
      t,
    });
    expect(options).toEqual([]);
  });
});

describe("folderPickerEmptyText", () => {
  it("returns the searching label while fetching", () => {
    expect(folderPickerEmptyText({ isFetching: true, t })).toBe(
      "newWorkspace.folderPicker.searching",
    );
    expect(folderPickerEmptyText({ isFetching: false, t })).toBe(
      "newWorkspace.folderPicker.noMatchingFolders",
    );
  });
});

describe("resolveFolderTargetView", () => {
  const selectedProject = project({ projectKey: "acme/app" });
  const base = {
    selectedProject,
    selectedSourceDirectory: "/work/app",
    projectTriggerLabel: "acme/app",
    selectedProjectOptionId: "proj:acme/app",
  };

  it("parks the project while a folder target is active", () => {
    const view = resolveFolderTargetView({ ...base, folderTarget: "/tmp/adhoc" });
    expect(view.project).toBeNull();
    expect(view.sourceDirectory).toBe("/tmp/adhoc");
    expect(view.pickerTargetId).toBe("dir:/tmp/adhoc");
    expect(view.comboboxValue).toBe("");
    expect(view.triggerLabel).toBe("adhoc");
  });

  it("passes the project through without a folder target", () => {
    const view = resolveFolderTargetView({ ...base, folderTarget: null });
    expect(view.project).toBe(selectedProject);
    expect(view.sourceDirectory).toBe("/work/app");
    expect(view.pickerTargetId).toBe("proj:acme/app");
    expect(view.comboboxValue).toBe("proj:acme/app");
    expect(view.triggerLabel).toBe("acme/app");
  });
});

describe("resolveFolderAwareWorktreeSupport", () => {
  const selectedProject = project({ projectKey: "acme/app", serverId: "host" });

  it("reports unsupported for folder targets even with a parked git project", () => {
    expect(
      resolveFolderAwareWorktreeSupport({
        folderTarget: "/tmp/adhoc",
        selectedProject,
        serverId: "host",
      }),
    ).toBe("unsupported");
  });

  it("delegates to the project placement without a folder target", () => {
    expect(
      resolveFolderAwareWorktreeSupport({
        folderTarget: null,
        selectedProject,
        serverId: "host",
      }),
    ).toBe("supported");
  });

  it("reports unsupported without any project", () => {
    expect(
      resolveFolderAwareWorktreeSupport({
        folderTarget: null,
        selectedProject: null,
        serverId: "host",
      }),
    ).toBe("unsupported");
  });
});

describe("resolveFolderPickerQueryEnabled", () => {
  it("only runs while the picker is open in folder mode with a ready client", () => {
    expect(
      resolveFolderPickerQueryEnabled({
        pickerOpen: true,
        mode: "folder",
        clientReady: true,
      }),
    ).toBe(true);
    expect(
      resolveFolderPickerQueryEnabled({
        pickerOpen: true,
        mode: "project",
        clientReady: true,
      }),
    ).toBe(false);
    expect(
      resolveFolderPickerQueryEnabled({
        pickerOpen: false,
        mode: "folder",
        clientReady: true,
      }),
    ).toBe(false);
    expect(
      resolveFolderPickerQueryEnabled({
        pickerOpen: true,
        mode: "folder",
        clientReady: false,
      }),
    ).toBe(false);
  });
});

describe("folderAwareShowRefPicker", () => {
  it("hides the ref picker for folder targets", () => {
    expect(folderAwareShowRefPicker(true, "/tmp/adhoc")).toBe(false);
    expect(folderAwareShowRefPicker(true, null)).toBe(true);
  });
});

describe("resolveProjectPickerPresentation", () => {
  const base = {
    projectOptions: [{ id: "proj:1", label: "one" }],
    comboboxValue: "proj:1",
    folderOptions: [{ id: "dir:/tmp/a", label: "a" }],
    folderEmptyText: "empty",
    onFolderQueryChange: () => {},
    footer: null,
    folderFooter: null,
    t,
  };

  it("exposes folder search wiring in folder mode", () => {
    const presentation = resolveProjectPickerPresentation({ ...base, mode: "folder" });
    expect(presentation.options).toBe(base.folderOptions);
    expect(presentation.value).toBe("");
    expect(presentation.onSearchQueryChange).toBe(base.onFolderQueryChange);
    expect(presentation.title).toBe("newWorkspace.folderPicker.title");
  });

  it("exposes project options in project mode", () => {
    const presentation = resolveProjectPickerPresentation({ ...base, mode: "project" });
    expect(presentation.options).toBe(base.projectOptions);
    expect(presentation.value).toBe("proj:1");
    expect(presentation.onSearchQueryChange).toBeUndefined();
    expect(presentation.title).toBe("Project");
  });
});

describe("dispatchProjectPickerSelect", () => {
  it("routes folder ids to the folder callback in folder mode", () => {
    const onFolderPath = vi.fn();
    const onProjectOption = vi.fn();
    dispatchProjectPickerSelect({
      mode: "folder",
      id: "dir:/tmp/x",
      onFolderPath,
      onProjectOption,
    });
    expect(onFolderPath).toHaveBeenCalledWith("/tmp/x");
    expect(onProjectOption).not.toHaveBeenCalled();
  });

  it("ignores non-folder ids in folder mode", () => {
    const onFolderPath = vi.fn();
    const onProjectOption = vi.fn();
    dispatchProjectPickerSelect({
      mode: "folder",
      id: "proj:1",
      onFolderPath,
      onProjectOption,
    });
    expect(onFolderPath).not.toHaveBeenCalled();
    expect(onProjectOption).not.toHaveBeenCalled();
  });

  it("routes project ids in project mode", () => {
    const onFolderPath = vi.fn();
    const onProjectOption = vi.fn();
    dispatchProjectPickerSelect({
      mode: "project",
      id: "proj:1",
      onFolderPath,
      onProjectOption,
    });
    expect(onProjectOption).toHaveBeenCalledWith("proj:1");
    expect(onFolderPath).not.toHaveBeenCalled();
  });
});

describe("useNewWorkspaceFolderTarget", () => {
  it("selects, trims, and clears the folder target", () => {
    const { result } = renderHook(() => useNewWorkspaceFolderTarget(null));
    expect(result.current.folderTarget).toBeNull();

    act(() => result.current.selectFolderTarget("  /tmp/adhoc  "));
    expect(result.current.folderTarget).toBe("/tmp/adhoc");

    act(() => result.current.clearFolderTarget());
    expect(result.current.folderTarget).toBeNull();
  });

  it("ignores empty selections and seeds from the initial target", () => {
    const { result } = renderHook(() => useNewWorkspaceFolderTarget("/tmp/seed"));
    expect(result.current.folderTarget).toBe("/tmp/seed");

    act(() => result.current.selectFolderTarget("   "));
    expect(result.current.folderTarget).toBe("/tmp/seed");
  });
});
