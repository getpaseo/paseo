import { describe, expect, test } from "vitest";
import { KeeperControl } from "./keeper-control.js";
import { dispatchKeeperMessage } from "./keeper-session-handlers.js";
import { sendKey, type ReceiptOutcome } from "./send-receipts.js";

const request = {
  requestId: "r",
  agentId: "a",
  text: "hi",
  idempotencyKey: "k",
  expectedSessionIncarnation: "i",
  expectedPermissionGeneration: 0,
  onActiveTurn: "reject",
} as never;

interface Internal {
  releaseReceipt: (req: unknown) => Promise<void>;
}

function build(options: {
  reserve: ReceiptOutcome;
  releaseFailures?: number;
  writeError?: Error;
  rejectAt?: "second";
  lookup?: ReceiptOutcome;
  agentGone?: boolean;
}) {
  const calls = { released: 0, committed: 0, logged: 0 };
  const events: Record<string, unknown>[] = [];
  const manager = {
    bootId: "boot",
    getAgent: () => (options.agentGone ? null : {}),
    admitGuarded: async (
      _id: string,
      guard: { reserve: (matched: unknown) => Promise<{ ok: boolean }> },
      commit: (context: unknown) => Promise<unknown>,
    ) => {
      const matched = {
        sessionIncarnation: "i",
        permissionGeneration: 0,
        lifecycle: "idle",
        hasActiveTurn: false,
        pending: [],
      };
      const reserved = await guard.reserve(matched);
      if (!reserved.ok) return { rejected: (reserved as { reason: string }).reason, state: null };
      if (options.rejectAt === "second") {
        await (guard as { release: () => Promise<void> }).release();
        return {
          rejected: "stale_generation",
          state: {
            sessionIncarnation: "i",
            permissionGeneration: 3,
            lifecycle: "idle",
            hasActiveTurn: false,
            pending: [],
          },
        };
      }
      calls.committed += 1;
      return { admitted: true, value: await commit({ agent: {}, state: matched }) };
    },
    // One event is enough for the first-event acknowledgement; the commit starts the turn.
    startTurnHeld: () =>
      (async function* () {
        yield {};
      })(),
    getControlState: () => null,
  };
  const receipts = {
    serialize: (_a: string, _k: string, op: () => Promise<unknown>) => op(),
    lookup: async () => options.lookup ?? { kind: "none" },
    reserve: async () => options.reserve,
    complete: async () => undefined,
    release: async () => {
      calls.released += 1;
      if (calls.released <= (options.releaseFailures ?? 0)) throw new Error("rm failed");
    },
  };
  const outbox = {
    lastWriteError: () => options.writeError ?? null,
    append: (event: Record<string, unknown>) => events.push(event),
    flush: async () => undefined,
  };
  const control = new KeeperControl({
    enabled: true,
    agentManager: manager,
    agentStorage: { get: async () => ({ archivedAt: null }) },
    receipts,
    outbox,
    logger: {
      error: () => {
        calls.logged += 1;
      },
    },
  } as never);
  return { control, calls, events };
}

describe("keeper control guards", () => {
  test("a receipt that appears at reserve time blocks the send and is not released", async () => {
    const { control, calls } = build({ reserve: { kind: "outcome_unknown" } });
    expect(await control.send(request)).toMatchObject({ result: "outcome_unknown" });
    expect(calls).toMatchObject({ released: 0, committed: 0 });
  });

  test("a stale-generation reject writes one send.rejected event; an accepted send writes none", async () => {
    const stale = build({ reserve: { kind: "none" }, rejectAt: "second" });
    expect(await stale.control.send(request)).toMatchObject({
      result: "rejected",
      reason: "stale_generation",
    });
    expect(stale.events).toEqual([
      expect.objectContaining({
        category: "send",
        type: "send.rejected",
        agentId: "a",
        bootId: "boot",
        sessionIncarnation: "i",
        permissionGeneration: 3,
        reason: "stale_generation",
        sendKey: sendKey("a", "k"),
      }),
    ]);
    const ok = build({ reserve: { kind: "none" } });
    expect(await ok.control.send(request)).toMatchObject({ result: "accepted" });
    expect(ok.events).toEqual([]);
  });

  test("a stalled feed prevents a clean rejected-send acknowledgement", async () => {
    const { control, calls, events } = build({
      reserve: { kind: "none" },
      rejectAt: "second",
      writeError: new Error("disk unavailable"),
    });
    expect(await control.send(request)).toMatchObject({
      result: "outcome_unknown",
      error: "disk unavailable",
    });
    expect(calls).toMatchObject({ committed: 0, logged: 1 });
    expect(events).toHaveLength(1);
  });

  test("a completed receipt that appears at reserve time answers duplicate", async () => {
    const { control, calls } = build({ reserve: { kind: "duplicate", delivery: "steered" } });
    expect(await control.send(request)).toMatchObject({ result: "duplicate", delivery: "steered" });
    expect(calls.committed).toBe(0);
  });

  test("a release that succeeds on the second attempt is retried and logged once", async () => {
    const { control, calls } = build({ reserve: { kind: "none" }, releaseFailures: 1 });
    await (control as unknown as Internal).releaseReceipt(request);
    expect(calls).toMatchObject({ released: 2, logged: 1 });
  });

  test("a release that fails twice surfaces, so the send never claims a clean rejection", async () => {
    const { control, calls } = build({
      reserve: { kind: "none" },
      releaseFailures: 2,
      rejectAt: "second",
    });
    expect(await control.send(request)).toMatchObject({ result: "outcome_unknown" });
    expect(calls).toMatchObject({ released: 2, logged: 2 });
  });

  test("a pending receipt answers outcome_unknown even when the agent is gone", async () => {
    const { control, calls } = build({
      reserve: { kind: "none" },
      lookup: { kind: "outcome_unknown" },
      agentGone: true,
    });
    expect(await control.send(request)).toMatchObject({ result: "outcome_unknown" });
    expect(calls.committed).toBe(0);
  });

  test("a latched outbox write error is reported by the feed", () => {
    const { control } = build({ reserve: { kind: "none" }, writeError: new Error("ENOSPC") });
    expect(control.feedError()).toBe("event feed stalled: ENOSPC");
    expect(build({ reserve: { kind: "none" } }).control.feedError()).toBeNull();
  });
});

describe("keeper feed handlers", () => {
  test("snapshot and events responses carry the stalled-feed error", async () => {
    const { control } = build({ reserve: { kind: "none" }, writeError: new Error("ENOSPC") });
    const live = {
      enabled: true,
      bootId: "b",
      snapshot: () => null,
      feedError: () => control.feedError(),
      readEvents: async () => ({
        events: [],
        nextCursor: "",
        headCursor: "",
        resyncRequired: false,
      }),
    };
    const seen: Array<{ payload: { error: string | null } }> = [];
    const emit = (m: unknown) => seen.push(m as never);
    for (const type of ["keeper.agent.get_snapshot.request", "keeper.events.read.request"]) {
      await dispatchKeeperMessage(
        live as never,
        { type, requestId: "r", agentId: "a" } as never,
        emit,
      );
    }
    expect(seen.map((m) => m.payload.error)).toEqual([
      "event feed stalled: ENOSPC",
      "event feed stalled: ENOSPC",
    ]);
  });
});
