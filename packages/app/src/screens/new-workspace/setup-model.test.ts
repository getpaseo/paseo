import { describe, expect, it } from "vitest";
import type { PickerItem } from "../new-workspace-picker-item";
import { createNewWorkspaceSetup, type SetupFacts } from "./setup-model";

function readyFacts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    locked: false,
    project: { id: "p1", name: "repo" },
    canCreateWorktree: true,
    supportsMetadata: true,
    chooseIsolation: () => {},
    chooseBase: () => {},
    ...overrides,
  };
}

describe("New workspace setup commands", () => {
  it("applies commands that run back to back without waiting for a render", async () => {
    const setup = createNewWorkspaceSetup();
    setup.report(readyFacts());

    void setup.commands.setBranch("pas-101");
    void setup.commands.setMetadata({ issue: "PAS-101", keep: true });
    await setup.commands.setMetadata({ keep: null });

    expect(setup.getSnapshot().branch).toBe("pas-101");
    expect(setup.getSnapshot().metadata).toEqual({ issue: "PAS-101" });
  });

  it("passes a base branch and an isolation choice to the picker's own handlers", async () => {
    const setup = createNewWorkspaceSetup();
    const chosen: PickerItem[] = [];
    const isolations: string[] = [];
    setup.report(
      readyFacts({
        chooseBase: (item) => chosen.push(item),
        chooseIsolation: (isolation) => isolations.push(isolation),
      }),
    );

    await setup.commands.setBaseRef({ type: "branch", name: " release " });
    await setup.commands.setIsolation("worktree");

    expect(chosen).toMatchObject([{ kind: "branch", name: "release", refName: "release" }]);
    expect(isolations).toEqual(["worktree"]);
  });

  it("rejects every command while the screen is locked, as the pickers do", async () => {
    const setup = createNewWorkspaceSetup();
    setup.report(readyFacts({ locked: true }));

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

  it("reads the facts when a command runs, so a project change after render is seen", async () => {
    const setup = createNewWorkspaceSetup();
    setup.report(readyFacts());
    const pending = setup.commands.setBaseRef({ type: "branch", name: "main" });
    setup.report(readyFacts({ project: null }));
    await pending;
    await expect(setup.commands.setBaseRef({ type: "branch", name: "main" })).rejects.toThrow(
      "Choose a project first.",
    );
  });

  it("rejects what the project or host cannot do", async () => {
    const setup = createNewWorkspaceSetup();
    setup.report(readyFacts({ canCreateWorktree: false, supportsMetadata: false }));

    await expect(setup.commands.setIsolation("worktree")).rejects.toThrow(
      "cannot create worktrees",
    );
    await expect(setup.commands.setMetadata({ a: 1 })).rejects.toThrow("Update the host");
    await expect(setup.commands.setBranch("  ")).rejects.toThrow("needs a name");
    await setup.commands.setBranch(null);
    expect(setup.getSnapshot().branch).toBeNull();
  });
});
