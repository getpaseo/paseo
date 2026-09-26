import { describe, expect, it } from "vitest";
import type {
  BrowserActivityEvent,
  BrowserHandoff,
} from "@getpaseo/protocol/browser-activity/rpc-schemas";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BrowserActivityHub } from "./browser-activity.js";
import type { BrowserToolsResponsePayload } from "./errors.js";

function createHub() {
  const events: BrowserActivityEvent[] = [];
  const hub = new BrowserActivityHub((event) => events.push(event));
  return { hub, events };
}

describe("BrowserActivityHub", () => {
  it("applies takeover only to the run on the same workspace and browser", () => {
    const { hub, events } = createHub();
    hub.start({ workspaceId: "ws-1", browserId: "tab-a", kind: "goal", label: "Sign in" });

    expect(hub.control({ workspaceId: "ws-2", browserId: "tab-a", action: "pause" })).toBe(false);
    expect(hub.control({ workspaceId: "ws-1", browserId: "tab-b", action: "pause" })).toBe(false);
    expect(events.at(-1)?.pauseRequested).toBe(false);

    expect(hub.control({ workspaceId: "ws-1", browserId: "tab-a", action: "pause" })).toBe(true);
    expect(events.at(-1)).toMatchObject({
      workspaceId: "ws-1",
      browserId: "tab-a",
      pauseRequested: true,
    });
  });

  it("pauses at the next checkpoint and reports the resume", async () => {
    const { hub, events } = createHub();
    const run = hub.start({ workspaceId: "ws-1", browserId: "tab-a", kind: "goal", label: "x" });
    run.update({ phase: "executing", step: 1, action: { operation: "CLICK", status: "active" } });

    expect(await run.checkpoint()).toBe(false);
    hub.control({ workspaceId: "ws-1", browserId: "tab-a", action: "pause" });
    let resumed: boolean | null = null;
    const checkpoint = run.checkpoint().then((value) => {
      resumed = value;
      return value;
    });
    await Promise.resolve();

    expect(resumed).toBeNull();
    expect(events.at(-1)).toMatchObject({ phase: "paused", pauseRequested: false, step: 1 });
    expect(events.at(-1)?.action).toBeUndefined();
    expect(hub.current()).toEqual([events.at(-1)]);

    hub.control({ workspaceId: "ws-1", browserId: "tab-a", action: "resume" });
    await checkpoint;
    expect(resumed).toBe(true);
  });

  it("cancels a pending takeover when resumed before the checkpoint", async () => {
    const { hub, events } = createHub();
    const run = hub.start({ workspaceId: "ws-1", browserId: "tab-a", kind: "goal", label: "x" });
    hub.control({ workspaceId: "ws-1", browserId: "tab-a", action: "pause" });
    hub.control({ workspaceId: "ws-1", browserId: "tab-a", action: "resume" });

    expect(events.at(-1)?.pauseRequested).toBe(false);
    expect(await run.checkpoint()).toBe(false);
  });

  it("publishes the terminal result once and forgets the run", () => {
    const { hub, events } = createHub();
    const run = hub.start({ workspaceId: "ws-1", browserId: "tab-a", kind: "recipe", label: "r" });
    run.update({
      phase: "executing",
      step: 1,
      next: { operation: "click", status: "pending" },
    });
    run.finish({ status: "passed", message: "done" });
    run.finish({ status: "failed", message: "late" });
    run.update({ phase: "executing", step: 2 });

    const terminal = events.filter((event) => event.phase === "finished");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ result: { status: "passed", message: "done" }, step: 1 });
    expect(terminal[0]?.next).toBeUndefined();
    expect(events.at(-1)?.phase).toBe("finished");
    expect(hub.current()).toEqual([]);
    expect(hub.control({ workspaceId: "ws-1", browserId: "tab-a", action: "pause" })).toBe(false);
  });
});

const TAB_A = "11111111-1111-4111-8111-111111111111";
const TAB_B = "22222222-2222-4222-8222-222222222222";

function createHandoffHub() {
  const published: BrowserHandoff[] = [];
  const ended: BrowserHandoff[] = [];
  const hub = new BrowserActivityHub(
    () => {},
    (handoff) => published.push(handoff),
  );
  const start = (browserId = TAB_A) =>
    hub.startHandoff({
      workspaceId: "ws-1",
      browserId,
      agentId: "agent-1",
      reason: "Sign in to example.com",
      onEnd: (handoff) => ended.push(handoff),
    });
  return { hub, published, ended, start };
}

function snapshotOf(browserId: string): { command: BrowserAutomationCommand } {
  return { command: { command: "snapshot", args: { browserId } } };
}

describe("BrowserActivityHub handoffs", () => {
  it("refuses agent commands on the handed-off tab only", async () => {
    const { hub, start } = createHandoffHub();
    const passedThrough: string[] = [];
    const execute = hub.guard(async (input: { command: BrowserAutomationCommand }) => {
      passedThrough.push(input.command.command);
      return { requestId: "ok", ok: true, result: { command: "list_tabs", tabs: [] } } as const;
    });
    start();

    const refused: BrowserToolsResponsePayload = await execute({
      ...snapshotOf(TAB_A),
      requestId: "agent-request",
    });
    await execute(snapshotOf(TAB_B));
    await execute({ command: { command: "list_tabs", args: {} } });

    expect(refused).toMatchObject({
      requestId: "agent-request",
      ok: false,
      error: { code: "browser_denied", retryable: false },
    });
    expect(refused.ok ? "" : refused.error.message).toContain(
      "The user controls this tab until they finish the handoff",
    );
    expect(passedThrough).toEqual(["snapshot", "list_tabs"]);
  });

  it("ends a handoff once, in its own workspace, and replays how it ended", () => {
    const { hub, published, ended, start } = createHandoffHub();
    const handoff = start();

    expect(hub.control({ workspaceId: "ws-2", browserId: TAB_A, action: "finish_handoff" })).toBe(
      false,
    );
    expect(hub.control({ workspaceId: "ws-1", browserId: TAB_A, action: "finish_handoff" })).toBe(
      true,
    );
    expect(hub.control({ workspaceId: "ws-1", browserId: TAB_A, action: "cancel_handoff" })).toBe(
      false,
    );

    expect(published.map((entry) => entry.status)).toEqual(["active", "done"]);
    expect(ended).toEqual([{ ...handoff, status: "done", updatedAt: ended[0]?.updatedAt }]);
    expect(hub.activeHandoff(TAB_A)).toBeNull();
    expect(hub.refuseHandedOff(snapshotOf(TAB_A).command)).toBeNull();
    expect(hub.currentHandoffs()).toEqual([ended[0]]);
  });

  it("reports a cancel and keeps runs on the browser untouched", () => {
    const { hub, ended, start } = createHandoffHub();
    hub.start({ workspaceId: "ws-1", browserId: TAB_A, kind: "goal", label: "x" });
    start();

    expect(hub.control({ workspaceId: "ws-1", browserId: TAB_A, action: "cancel_handoff" })).toBe(
      true,
    );
    expect(ended.map((entry) => entry.status)).toEqual(["cancelled"]);
    expect(hub.current()[0]?.pauseRequested).toBe(false);
  });

  it("does not replace a tab's active handoff", () => {
    const { hub, start } = createHandoffHub();
    const first = start();

    expect(
      hub.startHandoff({
        workspaceId: "ws-1",
        browserId: TAB_A,
        agentId: "agent-2",
        reason: "Confirm payment",
        onEnd: () => {},
      }),
    ).toBeNull();
    expect(hub.activeHandoff(TAB_A)).toBe(first);
  });
});
