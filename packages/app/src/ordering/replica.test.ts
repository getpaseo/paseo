import { expect, test } from "vitest";
import { OrderReplica, type OrderingPort } from "./replica";
import type { OrderRecord } from "@getpaseo/protocol/ordering";

const scope = { kind: "tabs", workspaceId: "w" } as const;
class FakeOrdering implements OrderingPort {
  readonly calls: Parameters<OrderingPort["setOrder"]>[0][] = [];
  readonly replies: Array<(value: { accepted: boolean; record: OrderRecord }) => void> = [];
  setOrder(input: Parameters<OrderingPort["setOrder"]>[0]) {
    this.calls.push(input);
    return new Promise<{ accepted: boolean; record: OrderRecord }>((resolve) =>
      this.replies.push(resolve),
    );
  }
}
function setup() {
  const port = new FakeOrdering();
  const applied: (readonly OrderRecord[])[] = [];
  const errors: unknown[] = [];
  const replica = new OrderReplica(
    port,
    (records) => applied.push(records),
    (error) => errors.push(error),
  );
  return { port, applied, replica, errors };
}
test("bootstrap and remote echoes never write the local cache back to the daemon", () => {
  const { port, replica } = setup();
  replica.snapshot([{ scope, revision: 2, order: ["b", "a"] }]);
  replica.receive(scope, { scope, revision: 3, order: ["a", "b"] });
  replica.reapply();
  expect(port.calls).toEqual([]);
});
test("rapid gestures serialize; echoes do not overwrite a pending local gesture", async () => {
  const { port, replica, applied } = setup();
  replica.snapshot([{ scope, revision: 1, order: ["a", "b", "c"] }]);
  replica.reorder(scope, ["b", "a", "c"]);
  replica.reorder(scope, ["c", "b", "a"]);
  replica.receive(scope, { scope, revision: 2, order: ["b", "a", "c"] });
  expect(applied.at(-1)).toEqual([]);
  port.replies[0]!({ accepted: true, record: { scope, revision: 2, order: ["b", "a", "c"] } });
  await Promise.resolve();
  expect(port.calls).toEqual([
    { scope, expectedRevision: 1, order: ["b", "a", "c"] },
    { scope, expectedRevision: 2, order: ["c", "b", "a"] },
  ]);
  port.replies[1]!({ accepted: true, record: { scope, revision: 3, order: ["c", "b", "a"] } });
  await Promise.resolve();
  expect(applied.at(-1)).toEqual([{ scope, revision: 3, order: ["c", "b", "a"] }]);
});
test("a revision conflict adopts shared authority and never replays the losing gesture", async () => {
  const { port, replica, applied } = setup();
  replica.snapshot([{ scope, revision: 1, order: ["a", "b"] }]);
  replica.reorder(scope, ["b", "a"]);
  replica.reorder(scope, ["b", "a", "c"]);
  port.replies[0]!({ accepted: false, record: { scope, revision: 2, order: ["a", "b"] } });
  await Promise.resolve();
  expect(port.calls).toHaveLength(1);
  expect(applied.at(-1)).toEqual([{ scope, revision: 2, order: ["a", "b"] }]);
});
test("a disposed connection ignores late mutation results", async () => {
  const { port, replica, applied } = setup();
  replica.snapshot([]);
  replica.reorder(scope, ["a"]);
  replica.dispose();
  port.replies[0]!({ accepted: true, record: { scope, revision: 1, order: ["a"] } });
  await Promise.resolve();
  expect(applied).toEqual([[]]);
});
test("an older response cannot undo a newer broadcast", async () => {
  const { port, replica, applied, errors } = setup();
  replica.snapshot([]);
  replica.reorder(scope, ["a"]);
  replica.reorder(scope, ["a", "c"]);
  replica.receive(scope, { scope, revision: 2, order: ["b", "a"] });
  port.replies[0]!({ accepted: true, record: { scope, revision: 1, order: ["a"] } });
  await Promise.resolve();
  expect(applied.at(-1)).toEqual([{ scope, revision: 2, order: ["b", "a"] }]);
  expect(port.calls).toHaveLength(1);
  expect(errors).toHaveLength(1);
});
