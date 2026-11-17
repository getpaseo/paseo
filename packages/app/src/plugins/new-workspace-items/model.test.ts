import { describe, expect, it } from "vitest";
import {
  buildBranchPickerItems,
  pickerItemToCheckoutRequest,
  type PickerItem,
} from "@/screens/new-workspace-picker-item";
import { createNewWorkspaceSetup } from "@/screens/new-workspace/setup-model";
import { toPluginNewWorkspace } from "./model";

const HOST = { id: "host", label: "Host" } as Parameters<typeof toPluginNewWorkspace>[0]["host"];

function viewOf(baseItem: PickerItem | null) {
  return {
    project: { id: "p", name: "repo" },
    isolation: "worktree" as const,
    baseItem,
    branch: null,
    metadata: {},
    locked: false,
  };
}

describe("the base ref a plugin reads", () => {
  it("names the exact ref creation uses, so setting it back picks the same base", async () => {
    // `release` exists locally and on origin, and the two have diverged.
    const rows = buildBranchPickerItems([
      {
        name: "release",
        committerDate: 0,
        hasLocal: true,
        hasRemote: true,
        localAhead: 2,
        localBehind: 1,
      },
    ]);
    const origin = rows.find((row) => row.kind === "branch" && row.refName.includes("remotes"));
    if (!origin) throw new Error("expected an origin row");

    const chosen: PickerItem[] = [];
    const setup = createNewWorkspaceSetup(
      {
        serverId: "host-a",
        locked: false,
        project: { id: "p", name: "repo" },
        canCreateWorktree: true,
        supportsMetadata: true,
      },
      { persistIsolation: () => {}, syncBaseAttachment: (item) => chosen.push(item) },
    );
    const read = toPluginNewWorkspace({
      host: HOST,
      view: viewOf(origin),
      commands: setup.commandsFor({ serverId: "host-a", projectId: "p" }),
    });

    expect(read.baseRef).toEqual({ type: "branch", name: "refs/remotes/origin/release" });
    if (read.baseRef?.type !== "branch") throw new Error("expected a branch");
    await read.setBaseRef(read.baseRef);

    expect(pickerItemToCheckoutRequest(chosen[0] ?? null)).toEqual(
      pickerItemToCheckoutRequest(origin),
    );
  });
});

describe("the metadata a plugin sets", () => {
  it("stays what the plugin set when the plugin reuses the object it handed in", async () => {
    const setup = createNewWorkspaceSetup(
      {
        serverId: "host-a",
        locked: false,
        project: { id: "p", name: "repo" },
        canCreateWorktree: true,
        supportsMetadata: true,
      },
      { persistIsolation: () => {}, syncBaseAttachment: () => {} },
    );
    const plugin = toPluginNewWorkspace({
      host: HOST,
      view: { ...viewOf(null), metadata: setup.getSnapshot().metadata },
      commands: setup.commandsFor({ serverId: "host-a", projectId: "p" }),
    });

    const issue = { id: "ISS-1" };
    await plugin.setMetadata({ issue });
    issue.id = "ISS-2";

    expect(setup.getSnapshot().metadata).toEqual({ issue: { id: "ISS-1" } });
  });
});
