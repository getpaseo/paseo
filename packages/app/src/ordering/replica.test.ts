import { expect, test } from "vitest";
import {
  OrderReplica,
  type OrderingPort,
  type SetOrderInput,
  type SetOrderResult,
} from "./replica";
import { createOrderMove, applyOrderMove } from "./move";
import type { OrderRecord } from "@getpaseo/protocol/ordering";
const scope = { kind: "tabs", workspaceId: "w" } as const;
class FakeOrdering implements OrderingPort {
  readonly calls: SetOrderInput[] = [];
  readonly replies: Array<(value: SetOrderResult) => void> = [];
  setOrder(input: SetOrderInput) {
    this.calls.push(input);
    return new Promise<SetOrderResult>((resolve) => this.replies.push(resolve));
  }
}
function setup() {
  const port = new FakeOrdering();
  const applied: (readonly OrderRecord[])[] = [];
  const errors: unknown[] = [];
  const replica = new OrderReplica({
    port,
    apply: (records) => applied.push(records),
    failed: (error) => errors.push(error),
  });
  return { port, applied, replica, errors };
}
test.each([
  [["a", "b", "c", "d"], "c", ["c", "a"], ["c", "a", "b", "d"]],
  [["a", "b", "c", "d"], "a", ["c", "a"], ["b", "c", "a", "d"]],
  [["a", "b", "d"], "x", ["a", "x", "d"], ["a", "b", "x", "d"]],
  [["a", "b"], "y", ["a", "y", "x"], ["a", "y", "b"]],
  [["a", "x", "b"], "a", ["b", "a"], ["x", "b", "a"]],
  [["a", "x", "b"], "b", ["b", "a"], ["b", "a", "x"]],
] as const)(
  "moves one explicit key and preserves every other pair: %j",
  (shared, moved, local, expected) => {
    expect(applyOrderMove(shared, createOrderMove({ moved, order: local }))).toEqual(expected);
  },
);
test("snapshots and echoes never write the local cache back", () => {
  const { port, replica } = setup();
  replica.snapshot([{ scope, revision: 2, order: ["b", "a"] }]);
  replica.receive(scope, { scope, revision: 3, order: ["a", "b"] });
  replica.reapply();
  expect(port.calls).toEqual([]);
});
test("all pre-snapshot operations fold on the latest revision without a 64-operation budget", async () => {
  const { port, replica, applied } = setup();
  for (let i = 0; i < 70; i++)
    replica.reorder({
      scope,
      move: createOrderMove({ moved: `new${i}`, order: [`new${i}`, "a"] }),
    });
  expect(port.calls).toEqual([]);
  replica.snapshot([{ scope, revision: 5, order: ["a", "b"] }]);
  expect(applied).toEqual([[]]);
  expect(port.calls[0]).toEqual({
    scope,
    expectedRevision: 5,
    order: [...Array.from({ length: 70 }, (_, i) => `new${i}`), "a", "b"],
  });
  port.replies[0]!({ accepted: true, record: { scope, revision: 6, order: port.calls[0]!.order } });
  await Promise.resolve();
  expect(applied.at(-1)).toEqual([{ scope, revision: 6, order: port.calls[0]!.order }]);
});
test("conflicts rebase the same move and retain it after bounded retries until reconnect", async () => {
  const { port, replica, errors, applied } = setup();
  replica.snapshot([{ scope, revision: 1, order: ["a", "b", "c", "d"] }]);
  replica.reorder({ scope, move: createOrderMove({ moved: "c", order: ["c", "a"] }) });
  for (let i = 0; i < 3; i++) {
    expect(port.calls[i]).toEqual({
      scope,
      expectedRevision: i + 1,
      order: i === 0 ? ["c", "a", "b", "d"] : ["d", "c", "a", "b"],
    });
    port.replies[i]!({
      accepted: false,
      record: { scope, revision: i + 2, order: ["d", "a", "b", "c"] },
    });
    await Promise.resolve();
  }
  expect(errors).toHaveLength(1);
  expect(applied.at(-1)).toEqual([]);
  replica.pause();
  replica.snapshot([{ scope, revision: 8, order: ["b", "a", "c", "d"] }]);
  expect(port.calls[3]).toEqual({ scope, expectedRevision: 8, order: ["b", "c", "a", "d"] });
});
test("disconnect retains in-flight and later moves, ignoring old acknowledgements", async () => {
  const { port, replica, applied } = setup();
  replica.snapshot([{ scope, revision: 1, order: ["a", "b", "c"] }]);
  replica.reorder({ scope, move: createOrderMove({ moved: "b", order: ["b", "a", "c"] }) });
  replica.pause();
  replica.reorder({ scope, move: createOrderMove({ moved: "c", order: ["c", "b", "a"] }) });
  replica.snapshot([{ scope, revision: 9, order: ["a", "b", "c", "remote"] }]);
  expect(port.calls[1]).toEqual({ scope, expectedRevision: 9, order: ["c", "b", "a", "remote"] });

  port.replies[0]!({ accepted: true, record: { scope, revision: 2, order: ["b", "a", "c"] } });
  await Promise.resolve();
  expect(port.calls[1]).toEqual({ scope, expectedRevision: 9, order: ["c", "b", "a", "remote"] });
  expect(applied.at(-1)).toEqual([]);
  expect(port.calls).toHaveLength(2);
});
test("an accepted older response preserves a newer broadcast without replaying acknowledged moves", async () => {
  const { port, replica, applied } = setup();
  replica.snapshot([{ scope, revision: 1, order: ["a", "b"] }]);
  replica.reorder({ scope, move: createOrderMove({ moved: "b", order: ["b", "a"] }) });
  replica.receive(scope, { scope, revision: 3, order: ["a", "b"] });
  port.replies[0]!({ accepted: true, record: { scope, revision: 2, order: ["b", "a"] } });
  await Promise.resolve();
  expect(port.calls).toHaveLength(1);
  expect(applied.at(-1)).toEqual([{ scope, revision: 3, order: ["a", "b"] }]);
});

test("a new scope establishes only the moved pair and never publishes the untouched cache", () => {
  const { port, replica } = setup();
  replica.reorder({ scope, move: createOrderMove({ moved: "a", order: ["untouched", "b", "a"] }) });
  replica.snapshot([]);
  expect(port.calls).toEqual([{ scope, expectedRevision: 0, order: ["b", "a"] }]);
});
