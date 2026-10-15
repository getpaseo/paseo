import { expect, test } from "vitest";
import { capturedToolCall, verifyTaskFixture } from "../task-fixture-test.js";
import { piExampleTodo } from "./index.js";

test("Pi example todo maps captured RPC tasks through live and history", async () => {
  await verifyTaskFixture(new URL("./fixtures/rpc-session.json", import.meta.url), [
    "pending",
    "pending,pending",
    "completed,pending",
  ]);
});

test("example todo declines rpiv-todo's shape", () => {
  const call = capturedToolCall(new URL("../rpiv-todo/fixtures/rpc-session.json", import.meta.url));
  expect(piExampleTodo.createSession().mapToolCall?.(call)).toBeUndefined();
});
