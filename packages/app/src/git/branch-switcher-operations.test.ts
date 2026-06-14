import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createBranchSwitcherOperations } from "./branch-switcher-operations";

function createRecordingClient() {
  const cwds: string[] = [];
  const client = {
    getBranchSuggestions: async (options: { cwd: string; limit?: number }) => {
      cwds.push(options.cwd);
      return { branches: [], error: null };
    },
    stashList: async (cwd: string) => {
      cwds.push(cwd);
      return { entries: [] };
    },
    stashSave: async (cwd: string) => {
      cwds.push(cwd);
      return { error: null };
    },
    stashPop: async (cwd: string) => {
      cwds.push(cwd);
      return { error: null };
    },
    checkoutSwitchBranch: async (cwd: string) => {
      cwds.push(cwd);
      return { error: null };
    },
  } as unknown as DaemonClient;
  return { client, cwds };
}

describe("createBranchSwitcherOperations", () => {
  it("sends the workspace directory as cwd to every git operation, never the workspace id", async () => {
    const workspaceDirectory = "/Users/dev/project";
    const workspaceId = "wks_3f9a2b1c";
    const { client, cwds } = createRecordingClient();

    const operations = createBranchSwitcherOperations(client, workspaceDirectory);
    await operations.getBranchSuggestions(200);
    await operations.listPaseoStashes();
    await operations.saveStash("main");
    await operations.popStash(0);
    await operations.switchBranch("feature");

    expect(cwds).toEqual([
      workspaceDirectory,
      workspaceDirectory,
      workspaceDirectory,
      workspaceDirectory,
      workspaceDirectory,
    ]);
    expect(cwds).not.toContain(workspaceId);
  });
});
