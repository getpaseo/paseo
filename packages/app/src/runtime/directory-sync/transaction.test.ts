import { describe, expect, it } from "vitest";
import { DirectoryTransactionOwner, type DirectorySourceToken } from "./transaction";

const epoch = (connectionEpoch: number): DirectorySourceToken => ({
  clientGeneration: 1,
  connectionEpoch,
});

type Event = "begin-new" | "first" | "second" | "finish-old" | "finish-new";

function permutations(events: Event[]): Event[][] {
  if (events.length === 0) return [[]];
  return events.flatMap((event, index) =>
    permutations(events.filter((_, candidate) => candidate !== index)).map((tail) =>
      [event].concat(tail),
    ),
  );
}

describe("DirectoryTransactionOwner", () => {
  it("applies every bounded two-refresh interleaving exactly once", () => {
    const schedules = permutations([
      "begin-new",
      "first",
      "second",
      "finish-old",
      "finish-new",
    ]).filter((events) => events.indexOf("begin-new") < events.indexOf("finish-new"));
    expect(schedules).toHaveLength(60);
    for (const events of schedules) {
      const owner = new DirectoryTransactionOwner<null, string>();
      const old = owner.begin(epoch(1), () => null);
      let current = old;
      const applied: string[] = [];
      for (const event of events) {
        if (event === "begin-new") current = owner.begin(epoch(1), () => null);
        if (event === "first" || event === "second") {
          if (!owner.record(epoch(1), event)) applied.push(event);
        }
        if (event === "finish-old") {
          const result = owner.complete(old);
          if (result.kind === "current") applied.push(...result.deltas);
        }
        if (event === "finish-new") {
          const result = owner.complete(current);
          if (result.kind === "current") applied.push(...result.deltas);
        }
      }
      expect(applied.sort(), JSON.stringify(events)).toEqual(["first", "second"]);
    }
  });

  it.each([
    ["success", false, false, ["delta"]],
    ["failure", true, false, ["delta"]],
    ["superseded success", false, true, ["delta"]],
    ["superseded failure", true, true, ["delta"]],
  ] as const)("preserves buffered deltas through %s", (_name, fail, supersede, expected) => {
    const owner = new DirectoryTransactionOwner<string[], string>();
    const first = owner.begin(epoch(1), () => []);
    owner.record(epoch(1), "delta");
    const current = supersede ? owner.begin(epoch(1), () => []) : first;

    let deltas: readonly string[] | null;
    if (fail) {
      deltas = owner.fail(current);
    } else {
      const completion = owner.complete(current);
      deltas = completion.kind === "current" ? completion.deltas : null;
    }

    expect(deltas).toEqual(expected);
    if (supersede) expect(owner.complete(first)).toEqual({ kind: "stale" });
  });

  it("makes a stale completion inert", () => {
    const owner = new DirectoryTransactionOwner<null, string>();
    const first = owner.begin(epoch(1), () => null);
    const second = owner.begin(epoch(1), () => null);
    expect(owner.complete(first)).toEqual({ kind: "stale" });
    expect(owner.isCurrent(second)).toBe(true);
  });

  it("isolates reconnect epochs", () => {
    const owner = new DirectoryTransactionOwner<null, string>();
    const disconnected = owner.begin(epoch(1), () => null);
    owner.record(epoch(1), "old");

    expect(owner.abort()).toEqual(["old"]);
    const reconnected = owner.begin(epoch(2), () => null);
    owner.record(epoch(2), "new");

    expect(owner.complete(disconnected)).toEqual({ kind: "stale" });
    expect(owner.complete(reconnected)).toEqual({
      kind: "current",
      snapshot: null,
      deltas: ["new"],
    });
  });
});
