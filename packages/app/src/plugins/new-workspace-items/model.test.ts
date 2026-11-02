import { describe, expect, it } from "vitest";
import {
  buildBranchPickerItems,
  pickerItemToCheckoutRequest,
  type PickerItem,
} from "@/screens/new-workspace-picker-item";
import { createNewWorkspaceSetup } from "@/screens/new-workspace/setup-model";
import { toPluginNewWorkspace } from "./model";

const HOST = { id: "host", label: "Host" } as Parameters<typeof toPluginNewWorkspace>[0]["host"];

function viewOf(baseItem: PickerItem) {
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

    const setup = createNewWorkspaceSetup({
      locked: false,
      project: { id: "p", name: "repo" },
      canCreateWorktree: true,
      supportsMetadata: true,
    });
    const chosen: PickerItem[] = [];
    setup.onBaseChosen((item) => chosen.push(item));
    const read = toPluginNewWorkspace({
      host: HOST,
      view: viewOf(origin),
      commands: setup.commands,
    });

    expect(read.baseRef).toEqual({ type: "branch", name: "refs/remotes/origin/release" });
    if (read.baseRef?.type !== "branch") throw new Error("expected a branch");
    await read.setBaseRef(read.baseRef);

    expect(pickerItemToCheckoutRequest(chosen[0] ?? null)).toEqual(
      pickerItemToCheckoutRequest(origin),
    );
  });
});
