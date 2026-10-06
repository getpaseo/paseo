import { afterEach, describe, expect, test } from "vitest";

import {
  closePlanSessions,
  type PlanSessionHarness,
  createPlanSession,
  settledOutcome,
  toolCallOptions,
} from "./test-utils/plan-session.js";

afterEach(closePlanSessions);

describe("Claude plan approval and query restarts", () => {
  async function requestPlanApproval(harness: PlanSessionHarness) {
    const callback = harness.canUseTool()(
      "ExitPlanMode",
      { plan: "Edit README.md" },
      toolCallOptions("tool-plan"),
    );
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending plan approval");
    return { callback, request };
  }

  async function planningSession(modeId: string): Promise<PlanSessionHarness> {
    const harness = await createPlanSession({ modeId });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan the docs change");
    return harness;
  }

  test("Implement leaves Plan and continues in Accept File Edits", async () => {
    const harness = await planningSession("bypassPermissions");
    const { callback, request } = await requestPlanApproval(harness);

    await harness.session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });

    await expect(callback).resolves.toMatchObject({ behavior: "allow" });
    await expect(harness.session.getCurrentMode()).resolves.toBe("acceptEdits");
    expect(harness.session.features).toContainEqual(
      expect.objectContaining({ id: "plan_mode", value: false }),
    );
    // The manager stores this, so a reload does not bring Plan back.
    expect(harness.session.featureValues).toEqual({ plan_mode: false });
    expect(harness.queries[0]?.permissionModes).toEqual(["plan", "acceptEdits"]);
  });

  test("Implement with Bypass leaves Plan and returns to Bypass", async () => {
    const harness = await planningSession("bypassPermissions");
    const { callback, request } = await requestPlanApproval(harness);

    expect(request.actions?.map((action) => action.id)).toEqual([
      "reject",
      "implement",
      "implement_resume",
    ]);
    await harness.session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "implement_resume",
    });

    await expect(callback).resolves.toMatchObject({ behavior: "allow" });
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(harness.queries[0]?.permissionModes).toEqual(["plan", "bypassPermissions"]);
  });

  test("rejecting a plan keeps planning and keeps the access mode", async () => {
    const harness = await planningSession("bypassPermissions");
    const { callback, request } = await requestPlanApproval(harness);

    await harness.session.respondToPermission(request.id, {
      behavior: "deny",
      selectedActionId: "reject",
      message: "Not yet",
    });

    await expect(callback).resolves.toMatchObject({ behavior: "deny" });
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(harness.session.features).toContainEqual(
      expect.objectContaining({ id: "plan_mode", value: true }),
    );
    expect(harness.queries[0]?.permissionModes).toEqual(["plan"]);
  });

  test("a plan approval queued behind another change does nothing once its card is gone", async () => {
    const harness = await createPlanSession({ modeId: "bypassPermissions" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan the docs change");
    const abort = new AbortController();
    const callback = settledOutcome(
      harness.canUseTool()(
        "ExitPlanMode",
        { plan: "Edit README.md" },
        { ...toolCallOptions("tool-plan"), signal: abort.signal },
      ),
    );
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending plan approval");

    const hold = harness.queries[0]?.holdNextPermissionMode();
    const planOff = harness.session.setFeature?.("plan_mode", false);
    const approval = harness.session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    abort.abort();
    hold?.release();
    await Promise.all([planOff, approval]);

    await expect(callback).resolves.toEqual({ rejected: "Permission request aborted" });
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(harness.queries[0]?.permissionModes).toEqual(["plan", "bypassPermissions"]);
  });

  test("a plan approval whose card is withdrawn while Plan is being left changes nothing", async () => {
    const harness = await createPlanSession({ modeId: "bypassPermissions" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan the docs change");
    const abort = new AbortController();
    const outcome = harness
      .canUseTool()(
        "ExitPlanMode",
        { plan: "Edit README.md" },
        { ...toolCallOptions("tool-plan"), signal: abort.signal },
      )
      .then(
        () => "answered",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending plan approval");
    const hold = harness.queries[0]?.holdNextPermissionMode();
    if (!hold) throw new Error("Expected a Claude query");

    const approval = harness.session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    await hold.reached;
    abort.abort();
    hold.release();
    await approval;

    await expect(outcome).resolves.toBe("Permission request aborted");
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(harness.session.features).toContainEqual(
      expect.objectContaining({ id: "plan_mode", value: true }),
    );
    expect(harness.queries[0]?.permissionModes.at(-1)).toBe("plan");
  });

  test("a withdrawn plan approval keeps Plan when Claude Code cannot take the mode back", async () => {
    const harness = await createPlanSession({ modeId: "bypassPermissions" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("plan the docs change");
    const abort = new AbortController();
    void harness
      .canUseTool()(
        "ExitPlanMode",
        { plan: "Edit README.md" },
        { ...toolCallOptions("tool-plan"), signal: abort.signal },
      )
      .catch(() => undefined);
    const [request] = harness.session.getPendingPermissions();
    if (!request) throw new Error("Expected a pending plan approval");
    const query = harness.queries[0];
    const hold = query?.holdNextPermissionMode();
    if (!query || !hold) throw new Error("Expected a Claude query");

    const approval = harness.session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    await hold.reached;
    abort.abort();
    query.failNextPermissionMode("Claude Code process exited");
    hold.release();

    await expect(approval).rejects.toThrow("Claude Code process exited");
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(harness.session.features).toContainEqual(
      expect.objectContaining({ id: "plan_mode", value: true }),
    );
    // The query that may still be in Accept File Edits is gone, and its turn ended with it.
    expect(query.isClosed()).toBe(true);
    expect(harness.events.map((event) => event.type)).toContain("turn_failed");
    await harness.session.startTurn("continue planning");
    expect(harness.launches).toHaveLength(2);
    expect(harness.launches[1]?.options.permissionMode).toBe("plan");
  });

  test("Always Ask plus Plan offers no Implement with Bypass", async () => {
    const harness = await planningSession("default");
    const { callback, request } = await requestPlanApproval(harness);

    expect(request.actions?.map((action) => action.id)).toEqual(["reject", "implement"]);
    await harness.session.respondToPermission(request.id, { behavior: "deny" });
    await expect(callback).resolves.toMatchObject({ behavior: "deny" });
  });

  test("a recreated query starts in plan while Bypass stays the access mode", async () => {
    const harness = await createPlanSession({ modeId: "bypassPermissions" });
    await harness.session.setFeature?.("plan_mode", true);
    await harness.session.startTurn("first turn");
    await harness.session.interrupt();

    await harness.session.setThinkingOption?.("high");
    await harness.session.startTurn("second turn");
    const outcome = await settledOutcome(
      harness.canUseTool()("mcp__qa__search_docs", { query: "x" }, toolCallOptions("tool-mcp")),
    );

    expect(harness.launches).toHaveLength(2);
    expect(harness.launches[1]?.options.permissionMode).toBe("plan");
    await expect(harness.session.getCurrentMode()).resolves.toBe("bypassPermissions");
    expect(outcome).toEqual({
      settled: true,
      result: expect.objectContaining({ behavior: "allow" }),
    });
  });
});
