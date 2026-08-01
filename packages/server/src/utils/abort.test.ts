import { expect, test, vi } from "vitest";

import { awaitWithAbort } from "./abort.js";

test("passes through operation resolution and rejection", async () => {
  await expect(awaitWithAbort(Promise.resolve("ready"))).resolves.toBe("ready");

  const operationError = new Error("operation failed");
  await expect(awaitWithAbort(Promise.reject(operationError))).rejects.toBe(operationError);
});

test("removes the abort listener after the operation settles", async () => {
  const controller = new AbortController();
  const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

  await expect(awaitWithAbort(Promise.resolve("ready"), controller.signal)).resolves.toBe("ready");

  expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
});

test("observes the operation before rejecting an already-aborted signal", async () => {
  const operation = new Promise<never>(() => undefined);
  const observed = vi.spyOn(operation, "then");
  const controller = new AbortController();
  const abortReason = new Error("catalog superseded");
  controller.abort(abortReason);

  await expect(awaitWithAbort(operation, controller.signal)).rejects.toBe(abortReason);

  expect(observed).toHaveBeenCalledOnce();
});

test("observes a late operation rejection after cancellation wins", async () => {
  let rejectOperation!: (reason: unknown) => void;
  const operation = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject;
  });
  const controller = new AbortController();
  const abortReason = new Error("catalog superseded");

  const result = awaitWithAbort(operation, controller.signal);
  controller.abort(abortReason);
  await expect(result).rejects.toBe(abortReason);

  rejectOperation(new Error("late operation failure"));
  await Promise.resolve();
});
