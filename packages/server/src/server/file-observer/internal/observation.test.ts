import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createFileObserver } from "../index.js";
import { createNativeRecursiveBackend } from "./native-recursive.js";
import { createManagedObservation } from "./observation.js";
import { createObserverPaths } from "./paths.js";

// Aborting a subscription closes its observation while start() may still be
// reading the root, before the backend has started.
test("closing an observation before its backend starts leaves no native watcher open", async () => {
  const root = await mkdtemp(join(tmpdir(), "observation-close-"));
  const paths = createObserverPaths(process.platform);
  let openWatchers = 0;
  const observation = createManagedObservation({
    root,
    callback: () => {},
    options: {},
    paths,
    metrics: createFileObserver().getDiagnostics(),
    createBackend: (host) =>
      createNativeRecursiveBackend(host, paths, () => {
        openWatchers += 1;
        let open = true;
        return {
          close: () => {
            if (open) openWatchers -= 1;
            open = false;
          },
          on: () => {},
        };
      }),
    onClosed: () => {},
  });
  try {
    const started = observation.start();
    const closed = observation.close();
    await started;
    await closed;

    expect(openWatchers).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
