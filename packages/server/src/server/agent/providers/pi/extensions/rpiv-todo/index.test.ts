import { expect, test } from "vitest";
import { capturedToolCall, verifyTaskFixture } from "../task-fixture-test.js";
import { rpivTodo } from "./index.js";

test("rpiv-todo maps captured RPC tasks through live and history", async () => {
  await verifyTaskFixture(new URL("./fixtures/rpc-session.json", import.meta.url), [
    "pending",
    "pending,pending",
    "in_progress,pending",
    "completed,pending",
  ]);
});

test("rpiv-todo declines the example todo result shape", () => {
  const call = capturedToolCall(
    new URL("../pi-example-todo/fixtures/rpc-session.json", import.meta.url),
  );
  expect(rpivTodo.createSession().mapToolCall?.(call)).toBeUndefined();
});
