import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createFileObserver } from "../index.js";
import { createLinuxBackend } from "./linux.js";
import { createObserverPaths } from "./paths.js";

// This backend keeps no file-level inventory and runs no periodic full-tree
// safety audit (see the comment on MAX_QUEUED_CLASSIFICATIONS in linux.ts), so
// a shed classification could never be recovered later the way the native
// backend's directory audit recovers one. Overflow must fail the observation
// loudly instead of silently dropping a create or delete.
test("the linux backend fails the observation when the classification queue overflows", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-classify-"));
  const paths = createObserverPaths("linux");
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  let failure: Error | null = null;
  const backend = createLinuxBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: () => {},
      fail: (error) => {
        // Mirror the real Observation host: a failure ends the subscription,
        // so isActive() must flip immediately and further events must not be
        // processed.
        active = false;
        failure = error;
      },
    },
    paths,
    (_directory, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event: string, onError: (error: Error) => void) => notifications.on(event, onError),
      } as never;
    },
  );
  try {
    await backend.start();
    // Emitted synchronously: no stat can settle before the last event lands,
    // so the queue grows monotonically until it overflows. Once it does,
    // isActive() flips false and the backend's own listener guard skips the
    // rest of the burst, so it's safe to keep emitting unconditionally.
    for (let index = 0; index < 20_000; index += 1) {
      notifications.emit("change", "rename", `module-${index}.js`);
    }
    expect(active).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/exceeded \d+ queued classifications/);
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});
