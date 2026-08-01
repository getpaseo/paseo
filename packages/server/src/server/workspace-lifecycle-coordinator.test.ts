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

test("drain waits for the real archive after its abortable wrapper rejects", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  const controller = new AbortController();
  let releaseArchive = () => {};
  const physicalArchive = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const archive = coordinator.runArchive(
    "workspace:ws-drain",
    () => physicalArchive,
    controller.signal,
  );
  await Promise.resolve();

  controller.abort();
  await expect(archive).rejects.toThrow("Workspace lifecycle operation canceled");

  let drained = false;
  const drain = coordinator.drain().then(() => {
    drained = true;
    return undefined;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  releaseArchive();
  await drain;
  expect(drained).toBe(true);
});

test("drain waits for workspace setup reservations", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  const reservation = coordinator.reserveWorkspaceSetup("ws-setup", "/worktrees/setup");

  let drained = false;
  const drain = coordinator.drain().then(() => {
    drained = true;
    return undefined;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  reservation.release();
  await drain;
  expect(drained).toBe(true);
});

test("drain waits for workspace ownership mutation reservations", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  const reservation = coordinator.reserveWorkspaceOwnershipMutation("ws-ownership");

  let drained = false;
  const drain = coordinator.drain().then(() => {
    drained = true;
    return undefined;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  reservation.release();
  await drain;
  expect(drained).toBe(true);
});
