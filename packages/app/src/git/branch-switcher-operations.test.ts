import { describe, expect, it } from "vitest";
import type { WorkspaceGitClient } from "./workspace-git";
import { createBranchSwitcherOperations } from "./branch-switcher-operations";

function createRecordingClient() {
  const calls: string[] = [];
  const client = {
    workspaceId: "wks_3f9a2b1c",
    cwd: "/Users/dev/project",
    getBranchSuggestions: async () => (calls.push("suggest"), { branches: [], error: null }),
    stashList: async () => (calls.push("list"), { entries: [] }),
    stashSave: async () => (calls.push("save"), { error: null }),
    stashPop: async () => (calls.push("pop"), { error: null }),
    switchBranch: async () => (calls.push("switch"), { error: null }),
  } as unknown as WorkspaceGitClient;
  return { client, calls };
}

describe("createBranchSwitcherOperations", () => {
  it("binds every operation to the selected workspace identity", async () => {
    const { client, calls } = createRecordingClient();

    const operations = createBranchSwitcherOperations(client);
    await operations.getBranchSuggestions(200);
    await operations.listPaseoStashes();
    await operations.saveStash("main");
    await operations.popStash(0);
    await operations.switchBranch("feature");

    expect(calls).toEqual(["suggest", "list", "save", "pop", "switch"]);
  });
});
