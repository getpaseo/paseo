import { expect, test } from "vitest";

import { withWorkspaceCleanupLock } from "./workspace-cleanup-lock.js";

test("serializes cleanup and restoration for the same directory", async () => {
  const events: string[] = [];
  let releaseCleanup = () => undefined;
  const cleanupCanFinish = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });

  const cleanup = withWorkspaceCleanupLock("/tmp/shared-worktree", async () => {
    events.push("cleanup-start");
    await cleanupCanFinish;
    events.push("cleanup-finish");
  });
  const restoration = withWorkspaceCleanupLock("/tmp/shared-worktree", async () => {
    events.push("restoration-start");
  });
  await Promise.resolve();

  expect(events).toEqual(["cleanup-start"]);

  releaseCleanup();
  await Promise.all([cleanup, restoration]);
  expect(events).toEqual(["cleanup-start", "cleanup-finish", "restoration-start"]);
});
