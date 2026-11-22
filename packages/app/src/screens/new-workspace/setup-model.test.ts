import { describe, expect, it } from "vitest";
import type { CheckoutWorktree } from "@getpaseo/protocol/messages";
import type { PickerItem } from "../new-workspace-picker-item";
import {
  BranchInWorktreeError,
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
  supportsRefActions: true,
  worktrees: [],
};

function worktree(path: string, branchName: string | null, containsCwd = false): CheckoutWorktree {
  return { path, branchName, head: null, createdAt: "2026-11-01T00:00:00.000Z", containsCwd };
}

const PROJECT_DIRECTORY = worktree("/repo", "main", true);
const FEATURE_WORKTREE = worktree("/worktrees/feature", "feature");

function branchItem(refName: string): PickerItem {
  const name = refName.replace(/^refs\/(heads|remotes\/origin)\//, "");
  return { kind: "branch", name, refName, accessibilityLabel: `${name}, branch` };
}

const PULL_REQUEST: PickerItem = {
  kind: "github-pr",
  item: {
    kind: "change_request",
    number: 42,
    title: "Add picker",
    url: "https://example.com/pull/42",
    state: "open",
    body: null,
    labels: [],
    baseRefName: "main",
    headRefName: "feature/picker",
  },
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

  it("branches off a plugin's base ref, even after the user switched branches to check out", async () => {
    const setup = createNewWorkspaceSetup(
      { ...READY, worktrees: [PROJECT_DIRECTORY] },
      recordingEffects().effects,
    );
    setup.chooseRefAction("branch", "checkout");

    await commandsOf(setup).setBaseRef({ type: "branch", name: "refs/remotes/origin/main" });

    expect(setup.refActionFor("branch")).toBe("branch-off");
    expect(setup.checkoutRequestFor(setup.getSnapshot().pickerSelection.selectedItem)).toEqual({
      action: "branch-off",
      refName: "refs/remotes/origin/main",
    });
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

describe("New workspace isolation and ref actions", () => {
  const WITH_WORKTREES: SetupInputs = {
    ...READY,
    worktrees: [PROJECT_DIRECTORY, FEATURE_WORKTREE],
  };

  it("works in an existing worktree without remembering it as the default isolation", () => {
    const { effects, isolations } = recordingEffects();
    const setup = createNewWorkspaceSetup(WITH_WORKTREES, effects);

    setup.chooseExistingWorktree(FEATURE_WORKTREE.path);

    expect(setup.getSnapshot().existingWorktreePath).toBe("/worktrees/feature");
    expect(isolations).toEqual([]);

    setup.chooseIsolation("worktree");

    expect(setup.getSnapshot().existingWorktreePath).toBeNull();
    expect(isolations).toEqual(["worktree"]);
  });

  it("branches off a branch and checks out a pull request until the user switches the action", () => {
    const setup = createNewWorkspaceSetup(WITH_WORKTREES, recordingEffects().effects);
    const release = branchItem("refs/remotes/origin/release");

    expect(setup.checkoutRequestFor(release)).toEqual({
      action: "branch-off",
      refName: "refs/remotes/origin/release",
    });
    expect(setup.checkoutRequestFor(PULL_REQUEST)?.action).toBe("checkout");

    setup.chooseRefAction("branch", "checkout");
    setup.chooseRefAction("github-pr", "branch-off");

    expect(setup.checkoutRequestFor(release)).toEqual({
      action: "checkout",
      refName: "refs/remotes/origin/release",
    });
    expect(setup.checkoutRequestFor(PULL_REQUEST)?.action).toBe("branch-off");
  });

  it("keeps the default actions on a host that cannot branch off a pull request", () => {
    const setup = createNewWorkspaceSetup(
      { ...WITH_WORKTREES, supportsRefActions: false },
      recordingEffects().effects,
    );

    setup.chooseRefAction("github-pr", "branch-off");

    expect(setup.refActionFor("github-pr")).toBe("checkout");
    expect(setup.checkoutRequestFor(PULL_REQUEST)?.action).toBe("checkout");
  });

  it("sends checking out a branch another worktree holds to that worktree", () => {
    const { effects, chosen, isolations } = recordingEffects();
    const setup = createNewWorkspaceSetup(WITH_WORKTREES, effects);
    setup.chooseRefAction("branch", "checkout");

    setup.chooseRef(branchItem("refs/remotes/origin/feature"));

    expect(setup.getSnapshot().existingWorktreePath).toBe("/worktrees/feature");
    expect(chosen).toEqual([]);

    setup.chooseRef(branchItem("refs/heads/main"));

    expect(setup.getSnapshot().existingWorktreePath).toBeNull();
    expect(setup.getSnapshot().manualIsolation).toBe("local");
    expect(isolations).toEqual([]);
  });

  it("takes a branch-off pick as the base even when a worktree holds the branch", () => {
    const { effects, chosen } = recordingEffects();
    const setup = createNewWorkspaceSetup(WITH_WORKTREES, effects);
    const feature = branchItem("refs/heads/feature");

    setup.chooseRef(feature);

    expect(chosen).toEqual([feature]);
    expect(setup.getSnapshot().existingWorktreePath).toBeNull();
  });

  it("refuses to check out a branch another worktree holds instead of creating a renamed copy", () => {
    const setup = createNewWorkspaceSetup(WITH_WORKTREES, recordingEffects().effects);
    setup.chooseRefAction("branch", "checkout");

    expect(() => setup.checkoutRequestFor(branchItem("refs/remotes/origin/main"))).toThrow(
      new BranchInWorktreeError({ branchName: "main", worktree: PROJECT_DIRECTORY }),
    );
  });

  it("drops the chosen existing worktree when the project changes", () => {
    const setup = createNewWorkspaceSetup(WITH_WORKTREES, recordingEffects().effects);
    setup.chooseExistingWorktree(FEATURE_WORKTREE.path);

    setup.syncInputs({ ...WITH_WORKTREES, project: { id: "p2", name: "other" } });

    expect(setup.getSnapshot().existingWorktreePath).toBeNull();
  });
});
