import { expect, test } from "vitest";
import { capturedToolCall, verifyTaskFixture } from "../task-fixture-test.js";
import { piGoalX } from "./index.js";

test("pi-goal-x maps captured RPC task tree through live and history", async () => {
  await verifyTaskFixture(new URL("./fixtures/rpc-session.json", import.meta.url), [
    "pending,pending",
    "completed,pending",
  ]);
});

test("pi-goal-x declines a foreign goal shape", () => {
  const call = capturedToolCall(new URL("../rpiv-todo/fixtures/rpc-session.json", import.meta.url));
  expect(piGoalX.createSession().mapToolCall?.({ ...call, toolName: "get_goal" })).toBeUndefined();
});
