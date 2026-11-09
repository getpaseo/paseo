import { describe, expect, it } from "vitest";
import type { PickerItem } from "../new-workspace-picker-item";
import {
  createNewWorkspaceSetup,
  setupTargetOf,
  type NewWorkspaceSetup,
  type SetupEffects,
  type SetupInputs,
} from "./setup-model";

const READY: SetupInputs = {
  serverId: "host-a",
  locked: false,
  project: { id: "p1", name: "repo" },
  canCreateWorktree: true,
  supportsMetadata: true,
};

/** The commands an item mounted for `inputs`' project and host receives. */
function commandsOf(setup: NewWorkspaceSetup, inputs: SetupInputs = READY) {
  return setup.commandsFor(setupTargetOf(inputs));
}

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

    await commandsOf(setup).setBranch("pas-101");

    expect(setup.getSnapshot().branch).toBe("pas-101");
  });

  it("applies commands that run back to back without waiting for a render", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);

    void commandsOf(setup).setBranch("pas-101");
    void commandsOf(setup).setMetadata({ issue: "PAS-101", keep: true });
    await commandsOf(setup).setMetadata({ keep: null });

    expect(setup.getSnapshot().branch).toBe("pas-101");
    expect(setup.getSnapshot().metadata).toEqual({ issue: "PAS-101" });
  });

  it("changes the model and runs the effects of a pick, for a base branch and an isolation choice", async () => {
    const { effects, chosen, isolations } = recordingEffects();
    const setup = createNewWorkspaceSetup(READY, effects);

    await commandsOf(setup).setBaseRef({ type: "branch", name: " release " });
    await commandsOf(setup).setIsolation("worktree");

    expect(chosen).toMatchObject([{ kind: "branch", name: "release", refName: "release" }]);
    expect(setup.getSnapshot().pickerSelection.selectedItem).toEqual(chosen[0]);
    expect(isolations).toEqual(["worktree"]);
    expect(setup.getSnapshot().manualIsolation).toBe("worktree");
  });

  it("shows a base ref's short name and keeps the exact ref for creation", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);

    await commandsOf(setup).setBaseRef({ type: "branch", name: "refs/remotes/origin/release" });

    expect(setup.getSnapshot().pickerSelection.selectedItem).toMatchObject({
      name: "release",
      refName: "refs/remotes/origin/release",
    });
  });

  it("drops the branch and metadata chosen for another project, but not while the project resolves", async () => {
    const resolving = { ...READY, project: null };
    const setup = createNewWorkspaceSetup(resolving, recordingEffects().effects);
    await commandsOf(setup, resolving).setBranch("pas-101");
    setup.syncInputs(READY);
    expect(setup.getSnapshot().branch).toBe("pas-101");

    await commandsOf(setup).setMetadata({ issue: "PAS-101" });
    setup.syncInputs({ ...READY, project: { id: "p2", name: "other" } });

    expect(setup.getSnapshot().branch).toBeNull();
    expect(setup.getSnapshot().metadata).toEqual({});
  });

  it("drops the branch and metadata when the host changes under the same project id", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);
    await commandsOf(setup).setBranch("pas-101");
    await commandsOf(setup).setMetadata({ issue: "PAS-101" });

    setup.syncInputs({ ...READY, serverId: "host-b" });

    expect(setup.getSnapshot().branch).toBeNull();
    expect(setup.getSnapshot().metadata).toEqual({});
  });

  it("rejects a late command from the project or host the screen has left, and leaves the new choices alone", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);
    const old = commandsOf(setup);
    const otherProject = { ...READY, project: { id: "p2", name: "other" } };
    const otherHost = { ...READY, serverId: "host-b" };

    setup.syncInputs(otherProject);
    await commandsOf(setup, otherProject).setBranch("chosen-for-p2");

    const results = await Promise.allSettled([
      old.setBranch("late"),
      old.setMetadata({ issue: "late" }),
      old.setIsolation("local"),
      old.setBaseRef({ type: "branch", name: "late" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(Array(4).fill("rejected"));
    await expect(old.setBranch("late")).rejects.toThrow("moved to another project or host");
    expect(setup.getSnapshot().branch).toBe("chosen-for-p2");
    expect(setup.getSnapshot().metadata).toEqual({});
    expect(setup.getSnapshot().manualIsolation).toBeNull();

    setup.syncInputs(otherHost);
    await expect(commandsOf(setup, otherProject).setBranch("late")).rejects.toThrow(
      "moved to another project or host",
    );
  });

  it("accepts commands again when the screen returns to the project they were made for", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);
    const first = commandsOf(setup);

    setup.syncInputs({ ...READY, project: { id: "p2", name: "other" } });
    setup.syncInputs(READY);
    await first.setBranch("back");

    expect(setup.getSnapshot().branch).toBe("back");
  });

  it("rejects every command while the screen is locked, as the pickers do", async () => {
    const setup = createNewWorkspaceSetup({ ...READY, locked: true }, recordingEffects().effects);

    const results = await Promise.allSettled([
      commandsOf(setup).setBranch("x"),
      commandsOf(setup).setMetadata({ a: 1 }),
      commandsOf(setup).setIsolation("local"),
      commandsOf(setup).setBaseRef({ type: "branch", name: "main" }),
    ]);

    expect(results.map((result) => result.status)).toEqual(Array(4).fill("rejected"));
    expect(setup.getSnapshot().branch).toBeNull();
    expect(setup.getSnapshot().metadata).toEqual({});
  });

  it("reads the inputs when a command runs, so a project change after render is seen", async () => {
    const setup = createNewWorkspaceSetup(READY, recordingEffects().effects);
    const resolving = { ...READY, project: null };
    setup.syncInputs(resolving);

    await expect(
      commandsOf(setup, resolving).setBaseRef({ type: "branch", name: "main" }),
    ).rejects.toThrow("Choose a project first.");
  });

  it("rejects what the project or host cannot do", async () => {
    const setup = createNewWorkspaceSetup(
      { ...READY, canCreateWorktree: false, supportsMetadata: false },
      recordingEffects().effects,
    );

    await expect(commandsOf(setup).setIsolation("worktree")).rejects.toThrow(
      "cannot create worktrees",
    );
    await expect(commandsOf(setup).setMetadata({ a: 1 })).rejects.toThrow("Update the host");
    await expect(commandsOf(setup).setBranch("  ")).rejects.toThrow("needs a name");
    await commandsOf(setup).setBranch(null);
    expect(setup.getSnapshot().branch).toBeNull();
  });
});
