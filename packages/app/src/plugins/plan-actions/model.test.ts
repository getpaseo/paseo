import { describe, expect, it } from "vitest";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { PlanActionState, resolvePlanActions, type PlanActionsInput } from "./model";

const permission: AgentPermissionRequest = {
  provider: "codex",
  name: "plan_approval",
  id: "permission-1",
  kind: "plan",
  sourcePlanCallId: "plan-1",
  actions: [{ id: "implement", label: "Implement", behavior: "allow", variant: "primary" }],
};

function input(overrides: Partial<PlanActionsInput> = {}): PlanActionsInput {
  return {
    callId: "plan-1",
    launchProfileId: "planner",
    live: true,
    readOnly: false,
    permissions: [permission],
    contributions: [
      {
        pluginId: "workflow",
        contribution: {
          id: "handoff",
          title: "Transférer le plan",
          order: 20,
          onPress() {},
        },
      },
      {
        pluginId: "workflow",
        contribution: {
          id: "review",
          title: "Revue",
          order: 10,
          query: { launchProfileId: "planner" },
          onPress() {},
        },
      },
    ],
    ...overrides,
  };
}

describe("plan actions", () => {
  it("offers live undecided structured fallback plans and keeps old hosts/cache read-only", () => {
    const fallback = input({ permissions: [], fallbackAvailable: true });
    expect(resolvePlanActions(fallback).map((action) => action.id)).toEqual([
      "copy",
      "workflow/review",
      "workflow/handoff",
      "approve",
    ]);
    for (const patch of [
      { live: false },
      { fallbackAvailable: false },
      { resolved: true },
      { readOnly: true },
    ])
      expect(resolvePlanActions({ ...fallback, ...patch }).map((action) => action.id)).toEqual([
        "copy",
      ]);
  });
  it("orders copy, matching plugin actions, then approval; only approval stays outside compact overflow", () => {
    const actions = resolvePlanActions(input());
    expect(actions.map((action) => action.id)).toEqual([
      "copy",
      "workflow/review",
      "workflow/handoff",
      "approve",
    ]);
    expect(actions.filter((action) => !action.overflow).map((action) => action.id)).toEqual([
      "copy",
      "workflow/review",
      "workflow/handoff",
      "approve",
    ]);
    expect(
      resolvePlanActions(input({ compact: true }))
        .filter((action) => !action.overflow)
        .map((action) => action.id),
    ).toEqual(["approve"]);
  });

  it("matches the launch profile exactly and never borrows another plan's permission", () => {
    expect(
      resolvePlanActions(input({ launchProfileId: "planner-other" })).map((action) => action.id),
    ).toEqual(["copy", "workflow/handoff", "approve"]);
    expect(resolvePlanActions(input({ callId: "plan-2" })).map((action) => action.id)).toEqual([
      "copy",
    ]);
    expect(
      resolvePlanActions(
        input({ permissions: [{ ...permission, sourcePlanCallId: undefined }] }),
      ).map((action) => action.id),
    ).toEqual(["copy"]);
  });

  it("keeps a disconnected cache read-only until a live permission snapshot returns", () => {
    for (const overrides of [{ live: false }, { readOnly: true }, { permissions: [] }]) {
      expect(resolvePlanActions(input(overrides)).map((action) => action.id)).toEqual(["copy"]);
    }
    expect(resolvePlanActions(input()).at(-1)?.permission?.id).toBe("permission-1");
  });

  it("keeps native approval when plugins are absent and surfaces a disabled reason", () => {
    expect(resolvePlanActions(input({ contributions: [] })).map((action) => action.id)).toEqual([
      "copy",
      "approve",
    ]);
    const missingProfile = input();
    missingProfile.contributions[0].contribution.disabledReason = "Executor profile missing";
    expect(
      resolvePlanActions(missingProfile).find((action) => action.id === "workflow/handoff"),
    ).toMatchObject({ disabled: true, disabledReason: "Executor profile missing" });
  });

  it.each(["workflow/review", "workflow/handoff", "approve"])(
    "locks all remote actions atomically during %s while copy remains independent",
    async (id) => {
      const state = new PlanActionState("plan-1");
      let finish!: () => void;
      let otherActions = 0;
      const pending = state.run(
        id,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      expect(state.getSnapshot().pending).toBe(id);
      const otherOperation = async () => {
        otherActions++;
      };
      await Promise.all(
        ["workflow/review", "workflow/handoff", "approve"].map((other) =>
          state.run(other, otherOperation),
        ),
      );
      await state.run("copy", async () => {
        otherActions++;
      });
      expect(otherActions).toBe(1);
      expect(state.getSnapshot()).toMatchObject({ pending: id, copied: true });
      finish();
      await pending;
      expect(state.getSnapshot().pending).toBe(null);
    },
  );

  it("isolates a throwing plugin, exposes the error and clears it on retry", async () => {
    const state = new PlanActionState("plan-1");
    await state.run("workflow/review", () => {
      throw new Error("Review unavailable");
    });
    expect(state.getSnapshot()).toMatchObject({ pending: null, error: "Review unavailable" });
    let finish!: () => void;
    const retry = state.run(
      "workflow/review",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(state.getSnapshot()).toMatchObject({ pending: "workflow/review", error: null });
    finish();
    await retry;
    expect(state.getSnapshot()).toMatchObject({ pending: null, error: null });
  });

  it("resets on callId change and ignores completion of the old plan", async () => {
    const state = new PlanActionState("plan-1");
    let fail!: (error: Error) => void;
    const pending = state.run(
      "approve",
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    state.setPlan("plan-2");
    expect(state.getSnapshot().callId).toBe("plan-2");
    await state.run("copy", async () => {});
    fail(new Error("Old approval failed"));
    await pending;
    expect(state.getSnapshot()).toEqual({
      callId: "plan-2",
      pending: null,
      error: null,
      copying: false,
      copied: true,
      copyError: null,
    });
  });

  it("surfaces clipboard rejection independently from a remote failure", async () => {
    const state = new PlanActionState("plan-1");
    await state.run("approve", () => {
      throw new Error("Approval failed");
    });
    await state.run("copy", () => {
      throw new Error("Clipboard unavailable");
    });
    expect(state.getSnapshot()).toMatchObject({
      error: "Approval failed",
      copyError: "Clipboard unavailable",
      copying: false,
    });
    await state.run("copy", async () => {});
    expect(state.getSnapshot()).toMatchObject({
      error: "Approval failed",
      copyError: null,
      copied: true,
    });
  });
});
