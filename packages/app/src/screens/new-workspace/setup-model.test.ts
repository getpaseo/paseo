import { describe, expect, it } from "vitest";
import type { PickerItem } from "../new-workspace-picker-item";
import { createNewWorkspaceSetup, type SetupEffects, type SetupInputs } from "./setup-model";

const READY: SetupInputs = {
  serverId: "host-a",
  locked: false,
  project: { id: "p1", name: "repo" },
  canCreateWorktree: true,
  supportsMetadata: true,
};

function recordingEffects() {
  const chosen: PickerItem[] = [];
  const isolations: string[] = [];
  const effects: SetupEffects = {
    persistIsolation: (isolation) => isolations.push(isolation),
    syncBaseAttachment: (item) => chosen.push(item),
  };
  return { effects, chosen, isolations };
}

describe("New workspace setup commands", () => {
  it("accepts commands from the first moment, before the screen has committed", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);

    await setup.commands.setBranch("pas-101");

    expect(setup.getSnapshot().branch).toBe("pas-101");
  });

  it("applies commands that run back to back without waiting for a render", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);

    void setup.commands.setBranch("pas-101");
    void setup.commands.setMetadata({ issue: "PAS-101", keep: true });
    await setup.commands.setMetadata({ keep: null });

    expect(setup.getSnapshot().branch).toBe("pas-101");
    expect(setup.getSnapshot().metadata).toEqual({ issue: "PAS-101" });
  });

  it("changes the model and runs the effects of a pick, for a base branch and an isolation choice", async () => {
    const { effects, chosen, isolations } = recordingEffects();
    const setup = createNewWorkspaceSetup(READY, effects);

    await setup.commands.setBaseRef({ type: "branch", name: " release " });
    await setup.commands.setIsolation("worktree");

    expect(chosen).toMatchObject([{ kind: "branch", name: "release", refName: "release" }]);
    expect(setup.getSnapshot().pickerSelection.selectedItem).toEqual(chosen[0]);
    expect(isolations).toEqual(["worktree"]);
    expect(setup.getSnapshot().manualIsolation).toBe("worktree");
  });

  it("shows a base ref's short name and keeps the exact ref for creation", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);

    await setup.commands.setBaseRef({ type: "branch", name: "refs/remotes/origin/release" });

    expect(setup.getSnapshot().pickerSelection.selectedItem).toMatchObject({
      name: "release",
      refName: "refs/remotes/origin/release",
    });
  });

  it("drops the branch and metadata chosen for another project, but not while the project resolves", async () => {
    const setup = createNewWorkspaceSetup({ ...READY, project: null }, recordingEffects().effects);
    await setup.commands.setBranch("pas-101");
    setup.syncInputs(READY);
    expect(setup.getSnapshot().branch).toBe("pas-101");

    await setup.commands.setMetadata({ issue: "PAS-101" });
    setup.syncInputs({ ...READY, project: { id: "p2", name: "other" } });

    expect(setup.getSnapshot().branch).toBeNull();
    expect(setup.getSnapshot().metadata).toEqual({});
  });

  it("drops the branch and metadata when the host changes under the same project id", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);
    await setup.commands.setBranch("pas-101");
    await setup.commands.setMetadata({ issue: "PAS-101" });

    setup.syncInputs({ ...READY, serverId: "host-b" });

    expect(setup.getSnapshot().branch).toBeNull();
    expect(setup.getSnapshot().metadata).toEqual({});
  });

  it("rejects every command while the screen is locked, as the pickers do", async () => {
    const setup = createNewWorkspaceSetup({ ...READY, locked: true }, recordingEffects().effects);

    const results = await Promise.allSettled([
      setup.commands.setBranch("x"),
      setup.commands.setMetadata({ a: 1 }),
      setup.commands.setIsolation("local"),
      setup.commands.setBaseRef({ type: "branch", name: "main" }),
    ]);

    expect(results.map((result) => result.status)).toEqual(Array(4).fill("rejected"));
    expect(setup.getSnapshot().branch).toBeNull();
    expect(setup.getSnapshot().metadata).toEqual({});
  });

  it("reads the inputs when a command runs, so a project change after render is seen", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);
    setup.syncInputs({ ...READY, project: null });

    await expect(setup.commands.setBaseRef({ type: "branch", name: "main" })).rejects.toThrow(
      "Choose a project first.",
    );
  });

  it("rejects what the project or host cannot do", async () => {
    const setup = createNewWorkspaceSetup(
      { ...READY, canCreateWorktree: false, supportsMetadata: false },
      recordingEffects().effects,
    );

    await expect(setup.commands.setIsolation("worktree")).rejects.toThrow(
      "cannot create worktrees",
    );
    await expect(setup.commands.setMetadata({ a: 1 })).rejects.toThrow("Update the host");
    await expect(setup.commands.setBranch("  ")).rejects.toThrow("needs a name");
    await setup.commands.setBranch(null);
    expect(setup.getSnapshot().branch).toBeNull();
  });
});
