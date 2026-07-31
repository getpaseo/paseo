import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileObserver, type FileObserverDependencies } from "./observer.js";

class ObservationControls implements FileObserverDependencies {
  watches = 0;
  closes = 0;
  private change: ((filename: string | null) => void) | null = null;
  private timeout: (() => void | Promise<void>) | null = null;
  private interval: (() => void | Promise<void>) | null = null;

  watchDirectory(_directory: string, onChange: (filename: string | null) => void) {
    this.watches += 1;
    this.change = onChange;
    return { close: () => (this.closes += 1) };
  }

  setTimeout(callback: () => void | Promise<void>): ReturnType<typeof setTimeout> {
    this.timeout = callback;
    return 1 as ReturnType<typeof setTimeout>;
  }

  clearTimeout(): void {
    this.timeout = null;
  }

  setInterval(callback: () => void | Promise<void>): ReturnType<typeof setInterval> {
    this.interval = callback;
    return 2 as ReturnType<typeof setInterval>;
  }

  clearInterval(): void {
    this.interval = null;
  }

  async fileChanged(filename: string): Promise<void> {
    this.change?.(filename);
    const timeout = this.timeout;
    this.timeout = null;
    await timeout?.();
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-file-observer-"));
  roots.push(root);
  await writeFile(path.join(root, "file.txt"), "one", "utf8");
  return root;
}

describe("FileObserver", () => {
  test("shares one parent watcher and publishes each real version once", async () => {
    const root = await workspace();
    const controls = new ObservationControls();
    const observer = new FileObserver(controls);
    const firstUpdates: string[] = [];
    const secondUpdates: string[] = [];
    const first = await observer.subscribe({ cwd: root, path: "file.txt" }, (version) =>
      firstUpdates.push(version.status),
    );
    const second = await observer.subscribe({ cwd: root, path: "file.txt" }, (version) =>
      secondUpdates.push(version.status),
    );

    await writeFile(path.join(root, "file.txt"), "changed content", "utf8");
    await controls.fileChanged("file.txt");
    await controls.fileChanged("file.txt");

    expect(controls.watches).toBe(1);
    expect(firstUpdates).toEqual(["ready"]);
    expect(secondUpdates).toEqual(["ready"]);
    first.unsubscribe();
    expect(controls.closes).toBe(0);
    second.unsubscribe();
    expect(controls.closes).toBe(1);
  });

  test("coalesces concurrent subscriptions onto one watcher", async () => {
    const root = await workspace();
    const controls = new ObservationControls();
    const observer = new FileObserver(controls);

    const [first, second] = await Promise.all([
      observer.subscribe({ cwd: root, path: "file.txt" }, () => undefined),
      observer.subscribe({ cwd: root, path: "file.txt" }, () => undefined),
    ]);

    expect(controls.watches).toBe(1);
    first.unsubscribe();
    second.unsubscribe();
    expect(controls.closes).toBe(1);
  });

  test("publishes shared watcher updates in each subscriber's path coordinates", async () => {
    const root = await workspace();
    const aliasParent = await mkdtemp(path.join(os.tmpdir(), "paseo-file-observer-alias-"));
    roots.push(aliasParent);
    const aliasRoot = path.join(aliasParent, "workspace-link");
    await symlink(root, aliasRoot, "dir");
    const controls = new ObservationControls();
    const observer = new FileObserver(controls);
    const updates: Array<{ cwd: string; path: string }> = [];
    const direct = await observer.subscribe({ cwd: root, path: "file.txt" }, () => undefined);
    const alias = await observer.subscribe({ cwd: aliasRoot, path: "file.txt" }, (version) =>
      updates.push({ cwd: version.cwd, path: version.path }),
    );

    await writeFile(path.join(root, "file.txt"), "changed content", "utf8");
    await controls.fileChanged("file.txt");

    expect(controls.watches).toBe(1);
    expect(updates).toEqual([{ cwd: aliasRoot, path: "file.txt" }]);
    direct.unsubscribe();
    alias.unsubscribe();
  });

  test("publishes deletion without dropping the subscription", async () => {
    const root = await workspace();
    const controls = new ObservationControls();
    const observer = new FileObserver(controls);
    const updates: string[] = [];
    const subscription = await observer.subscribe({ cwd: root, path: "file.txt" }, (version) =>
      updates.push(version.status),
    );

    await unlink(path.join(root, "file.txt"));
    await controls.fileChanged("file.txt");

    expect(updates).toEqual(["missing"]);
    subscription.unsubscribe();
  });
});
