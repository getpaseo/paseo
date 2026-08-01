import { expect, test, vi } from "vitest";

import { WorkspaceLifecycleCoordinator } from "./workspace-lifecycle-coordinator.js";

test("cancels a workspace setup wait without waiting for the setup to settle", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  const reservation = coordinator.reserveWorkspaceSetup("ws-blocked", "/worktrees/blocked");
  const controller = new AbortController();

  const waiting = coordinator.waitForWorkspaceSetups(["ws-blocked"], controller.signal);
  controller.abort();

  await expect(waiting).rejects.toThrow("Workspace lifecycle operation canceled");
  reservation.release();
});

test("cancels a queued worktree mutation before it starts", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  let releaseFirst = () => {};
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = coordinator.runWorktreeMutationExclusive("/worktrees", () => firstBlocked);
  const secondOperation = vi.fn(async () => undefined);
  const controller = new AbortController();
  const second = coordinator.runWorktreeMutationExclusive(
    "/worktrees",
    secondOperation,
    controller.signal,
  );

  controller.abort();

  await expect(second).rejects.toThrow("Workspace lifecycle operation canceled");
  expect(secondOperation).not.toHaveBeenCalled();
  releaseFirst();
  await first;
  await Promise.resolve();
  expect(secondOperation).not.toHaveBeenCalled();
});
