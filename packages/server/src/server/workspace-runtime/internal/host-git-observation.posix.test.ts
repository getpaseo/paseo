import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  type FileObserver,
  type FileObserverCallback,
  type FileObserverDiagnostics,
  type FileObserverOptions,
} from "../../file-observer/index.js";
import { getGitCommonDir } from "../../../utils/worktree.js";
import { createHostGitObservationOwner } from "./host-git-observation.js";

describe.runIf(process.platform !== "win32")("host Git observation on POSIX", () => {
  test("sibling host worktrees share one physical common-Git observation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-host-git-observation-"));
    try {
      const source = await repository(path.join(root, "source"));
      const sibling = path.join(root, "sibling");
      git(source, ["branch", "sibling"]);
      git(source, ["worktree", "add", sibling, "sibling"]);
      const unrelated = await repository(path.join(root, "unrelated"));
      const observer = new InstrumentedFileObserver();
      const owner = createHostGitObservationOwner(observer);
      let sourceChanges = 0;
      let siblingChanges = 0;
      let unrelatedChanges = 0;

      const [sourceSubscription, siblingSubscription] = await Promise.all([
        owner.observe(source, () => {
          sourceChanges += 1;
        }),
        owner.observe(sibling, () => {
          siblingChanges += 1;
        }),
      ]);
      expect(owner.getDiagnostics().activeObservationCount).toBe(1);

      const unrelatedSubscription = await owner.observe(unrelated, () => {
        unrelatedChanges += 1;
      });
      expect(owner.getDiagnostics().activeObservationCount).toBe(2);

      observer.emit(await realpath(await getGitCommonDir(source)));
      expect(sourceChanges).toBe(1);
      expect(siblingChanges).toBe(1);
      expect(unrelatedChanges).toBe(0);

      await sourceSubscription.unsubscribe();
      expect(owner.getDiagnostics().activeObservationCount).toBe(2);
      await siblingSubscription.unsubscribe();
      expect(owner.getDiagnostics().activeObservationCount).toBe(1);
      await unrelatedSubscription.unsubscribe();
      expect(owner.getDiagnostics().activeObservationCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failed physical common watcher rebinds once without changing logical ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-host-git-rebind-"));
    try {
      const source = await repository(path.join(root, "source"));
      const sibling = path.join(root, "sibling");
      git(source, ["branch", "sibling"]);
      git(source, ["worktree", "add", sibling, "sibling"]);
      const observer = new InstrumentedFileObserver();
      const owner = createHostGitObservationOwner(observer);
      let notifications = 0;
      const subscriptions = await Promise.all([
        owner.observe(source, () => {
          notifications += 1;
        }),
        owner.observe(sibling, () => {
          notifications += 1;
        }),
      ]);
      expect(observer.subscribeCount).toBe(1);
      expect(observer.getDiagnostics().activeObservationCount).toBe(1);

      observer.failActive(new Error("physical watcher failed"));
      const barrier = await owner.observe(sibling, () => undefined);
      expect(notifications).toBe(2);
      expect(observer.subscribeCount).toBe(2);
      expect(observer.getDiagnostics().activeObservationCount).toBe(1);

      await Promise.all([
        ...subscriptions.map((subscription) => subscription.unsubscribe()),
        barrier.unsubscribe(),
      ]);
      expect(observer.getDiagnostics().activeObservationCount).toBe(0);
      await observer.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

class InstrumentedFileObserver implements FileObserver {
  readonly callbacks = new Map<FileObserverCallback, string>();
  subscribeCount = 0;

  async subscribe(
    directory: string,
    callback: FileObserverCallback,
    _options?: FileObserverOptions,
  ) {
    this.subscribeCount += 1;
    this.callbacks.set(callback, directory);
    let active = true;
    return {
      updateIgnore: async (_paths: string[]) => {},
      unsubscribe: async () => {
        if (!active) return;
        active = false;
        this.callbacks.delete(callback);
      },
    };
  }

  failActive(error: Error): void {
    for (const callback of this.callbacks.keys()) callback(error, []);
  }

  emit(directory: string): void {
    for (const [callback, observedDirectory] of this.callbacks) {
      if (observedDirectory === directory)
        callback(null, [{ path: "refs/heads/main", type: "update" }]);
    }
  }

  getDiagnostics(): FileObserverDiagnostics {
    return {
      activeObservationCount: this.callbacks.size,
      nativeHandleCount: 0,
      nativeTrackedFileCount: 0,
      pendingEventCount: 0,
      pendingReconciliationWorkCount: 0,
      reconciliationInFlightCount: 0,
      reconciliationCount: 0,
      scopedReconciliationCount: 0,
      fullReconciliationCount: 0,
      reconciliationFailureCount: 0,
      observerFailureCount: 0,
      directoryLimitFailureCount: 0,
      nativeEventCount: 0,
      nativeChangeEventCount: 0,
      nativeRenameEventCount: 0,
      nativePathlessEventCount: 0,
      nativeClassificationCount: 0,
      nativeShallowScanCount: 0,
      lastReconciliationDurationMs: 0,
      maxReconciliationDurationMs: 0,
    };
  }

  async close(): Promise<void> {
    this.callbacks.clear();
  }
}

async function repository(directory: string): Promise<string> {
  await mkdir(directory);
  git(directory, ["init", "-b", "main"]);
  git(directory, ["config", "user.email", "test@getpaseo.local"]);
  git(directory, ["config", "user.name", "Paseo Test"]);
  await writeFile(path.join(directory, "tracked.txt"), "tracked\n");
  git(directory, ["add", "."]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  return directory;
}

function git(cwd: string, argv: string[]): void {
  execFileSync("git", argv, { cwd, stdio: "pipe" });
}
