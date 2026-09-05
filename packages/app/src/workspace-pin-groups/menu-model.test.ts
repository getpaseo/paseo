import { describe, expect, it } from "vitest";
import {
  buildWorkspacePinGroupMenuModel,
  isWorkspacePinnedInGroup,
  planWorkspacePinMutation,
  reconcileWorkspacePinGroupSelection,
  resolveWorkspacePinAction,
  resolveWorkspacePinGroupServerId,
} from "./menu-model";

const groups = [
  { id: "default", name: "Pinned", createdAt: "2026-01-01T00:00:00Z" },
  { id: "team", name: "Team", createdAt: "2026-02-01T00:00:00Z" },
];

describe("reconcileWorkspacePinGroupSelection", () => {
  it("switches another host's active workspace to that host's default group", () => {
    expect(
      reconcileWorkspacePinGroupSelection({
        registeredServerIds: ["server-a", "server-b"],
        activePinGroup: { serverId: "server-a", groupId: "team" },
        activeWorkspaceServerId: "server-b",
      }),
    ).toEqual({ serverId: "server-b", groupId: "default" });
  });

  it("initializes a null selection from the active workspace host", () => {
    expect(
      reconcileWorkspacePinGroupSelection({
        registeredServerIds: ["server-a"],
        activePinGroup: null,
        activeWorkspaceServerId: "server-a",
      }),
    ).toEqual({ serverId: "server-a", groupId: "default" });
  });

  it("preserves a custom group while navigating within its host", () => {
    const activePinGroup = { serverId: "server-a", groupId: "team" };
    expect(
      reconcileWorkspacePinGroupSelection({
        registeredServerIds: ["server-a", "server-b"],
        activePinGroup,
        activeWorkspaceServerId: "server-a",
      }),
    ).toBe(activePinGroup);
  });

  it("ignores an active workspace whose host is no longer registered", () => {
    const activePinGroup = { serverId: "server-a", groupId: "default" };
    expect(
      reconcileWorkspacePinGroupSelection({
        registeredServerIds: ["server-a"],
        activePinGroup,
        activeWorkspaceServerId: "server-b",
      }),
    ).toBe(activePinGroup);
  });
});

describe("resolveWorkspacePinGroupServerId", () => {
  it("preserves a registered host-scoped default selection", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        registeredServerIds: ["server-b", "server-a", "legacy"],
        activePinGroup: { serverId: "server-a", groupId: "default" },
        activeWorkspaceServerId: "server-b",
        hostFilters: [],
      }),
    ).toBe("server-a");
  });

  it("uses the active workspace host when no selection exists", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        registeredServerIds: ["server-b", "server-a", "legacy"],
        activePinGroup: null,
        activeWorkspaceServerId: "legacy",
        hostFilters: ["server-b"],
      }),
    ).toBe("legacy");
  });

  it("uses a sole registered host filter without an active workspace host", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        registeredServerIds: ["server-b", "server-a", "legacy"],
        activePinGroup: null,
        activeWorkspaceServerId: null,
        hostFilters: ["server-b"],
      }),
    ).toBe("server-b");
  });

  it("falls back deterministically across registered hosts", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        registeredServerIds: ["server-b", "server-a", "legacy"],
        activePinGroup: null,
        activeWorkspaceServerId: null,
        hostFilters: [],
      }),
    ).toBe("legacy");
  });

  it("moves on only after the selected host is removed from the registry", () => {
    expect(
      resolveWorkspacePinGroupServerId({
        registeredServerIds: ["server-b"],
        activePinGroup: { serverId: "server-a", groupId: "team" },
        activeWorkspaceServerId: "server-b",
        hostFilters: [],
      }),
    ).toBe("server-b");
  });
});

describe("resolveWorkspacePinAction", () => {
  const activePinGroup = { serverId: "server-a", groupId: "default" };

  it("returns membership access only for the selected capable host", () => {
    expect(
      resolveWorkspacePinAction({
        workspaceServerId: "server-a",
        pinGroupAvailability: true,
        activePinGroup,
      }),
    ).toEqual({ kind: "set-membership", selection: activePinGroup });
    expect(
      resolveWorkspacePinAction({
        workspaceServerId: "server-b",
        pinGroupAvailability: true,
        activePinGroup,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("distinguishes an old host from a reconnecting host", () => {
    expect(
      resolveWorkspacePinAction({
        workspaceServerId: "server-a",
        pinGroupAvailability: false,
        activePinGroup,
      }),
    ).toEqual({ kind: "update-host" });
    expect(
      resolveWorkspacePinAction({
        workspaceServerId: "server-a",
        pinGroupAvailability: null,
        activePinGroup,
      }),
    ).toEqual({ kind: "host-disconnected" });
  });
});

describe("buildWorkspacePinGroupMenuModel", () => {
  it("marks the active choice and protects the default group", () => {
    expect(buildWorkspacePinGroupMenuModel({ groups, activeGroupId: "default" })).toEqual({
      activeGroup: groups[0],
      choices: [
        { group: groups[0], selected: true },
        { group: groups[1], selected: false },
      ],
      actions: ["create"],
    });
  });

  it("offers rename and delete for a custom active group", () => {
    expect(buildWorkspacePinGroupMenuModel({ groups, activeGroupId: "team" })).toEqual({
      activeGroup: groups[1],
      choices: [
        { group: groups[0], selected: false },
        { group: groups[1], selected: true },
      ],
      actions: ["create", "rename", "delete"],
    });
  });
});

describe("isWorkspacePinnedInGroup", () => {
  it("treats a workspace in another group as unpinned", () => {
    expect(
      isWorkspacePinnedInGroup({
        pinGroupId: "review",
        activeGroupId: "team",
      }),
    ).toBe(false);
  });

  it("recognizes active non-default membership without a legacy timestamp", () => {
    expect(
      isWorkspacePinnedInGroup({
        pinGroupId: "team",
        activeGroupId: "team",
      }),
    ).toBe(true);
  });
});

describe("planWorkspacePinMutation", () => {
  it("moves a workspace from another group into the active group", () => {
    expect(
      planWorkspacePinMutation({
        pinGroupId: "review",
        activeGroupId: "team",
      }),
    ).toEqual({ groupId: "team" });
  });

  it("unpins a workspace from the active group", () => {
    expect(
      planWorkspacePinMutation({
        pinGroupId: "team",
        activeGroupId: "team",
      }),
    ).toEqual({ groupId: null });
  });
});
