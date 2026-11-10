import { expect, test } from "vitest";
import { isRecoverableRejection } from "./recoverable-rejection.js";
import { WorkspaceGitWatcherSubscriptionTimeoutError } from "./workspace-git-service.js";

test("a workspace watcher subscription timeout does not take the worker down", () => {
  expect(isRecoverableRejection(new WorkspaceGitWatcherSubscriptionTimeoutError("/repo"))).toBe(
    true,
  );
});

test("any other rejection still takes the worker down", () => {
  expect(isRecoverableRejection(new Error("boom"))).toBe(false);
  expect(isRecoverableRejection("timed out")).toBe(false);
});
