import { afterEach, describe, expect, it, vi } from "vitest";
import { PathIndexes, type BuildIndex, type IndexedEntry } from "./path-index.js";

function entry(relativePath: string): IndexedEntry {
  const lowerPath = relativePath.toLowerCase();
  return { kind: "file", relativePath, lowerPath, mask: 0, ascii: true };
}

function watchedIndexes(options: { idleMs?: number; watchFails?: boolean } = {}) {
  const watch = { roots: [] as string[], unwatched: 0, changed: () => {} };
  const indexes = new PathIndexes({
    idleMs: options.idleMs,
    watch: async (root, onChange) => {
      if (options.watchFails) throw new Error("watch unavailable");
      watch.roots.push(root);
      watch.changed = onChange;
      return () => {
        watch.unwatched += 1;
      };
    },
  });
  return { indexes, watch };
}

function diskBuild(initial: string[]) {
  const disk = { files: initial, builds: 0, hold: null as Promise<void> | null };
  const build = async () => {
    disk.builds += 1;
    const snapshot = [...disk.files];
    if (disk.hold) await disk.hold;
    return snapshot.map(entry);
  };
  return { disk, build };
}

async function search(indexes: PathIndexes, signature: string, build: BuildIndex) {
  const entries = await indexes.get("key", signature, build);
  if (!entries) indexes.prepare("key", "/root", signature, build);
  return entries;
}

describe("PathIndexes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds before answering after a watched change", async () => {
    const { indexes, watch } = watchedIndexes();
    const { disk, build } = diskBuild(["a.ts"]);

    const first = await search(indexes, "", build);
    await indexes.idle();
    const built = await search(indexes, "", build);
    disk.files = ["a.ts", "b.ts"];
    watch.changed();
    const changed = await search(indexes, "", build);

    expect({ first, built, changed, builds: disk.builds, roots: watch.roots }).toEqual({
      first: null,
      built: [entry("a.ts")],
      changed: [entry("a.ts"), entry("b.ts")],
      builds: 2,
      roots: ["/root"],
    });
  });

  it("rebuilds again when a change lands during the rebuild", async () => {
    const { indexes, watch } = watchedIndexes();
    const { disk, build } = diskBuild(["a.ts"]);
    await search(indexes, "", build);
    await indexes.idle();
    let release = () => {};
    disk.hold = new Promise((resolve) => {
      release = resolve;
    });
    disk.files = ["a.ts", "b.ts"];
    watch.changed();

    const pending = search(indexes, "", build);
    disk.files = ["a.ts", "b.ts", "c.ts"];
    watch.changed();
    disk.hold = null;
    release();

    expect({ entries: await pending, builds: disk.builds }).toEqual({
      entries: [entry("a.ts"), entry("b.ts"), entry("c.ts")],
      builds: 3,
    });
  });

  it("rebuilds when the ignore set changes", async () => {
    const { indexes } = watchedIndexes();
    const { disk, build } = diskBuild(["a.ts", "dist/b.js"]);
    await search(indexes, "", build);
    await indexes.idle();
    disk.files = ["a.ts"];

    const entries = await search(indexes, "/root/dist", build);

    expect({ entries, builds: disk.builds }).toEqual({ entries: [entry("a.ts")], builds: 2 });
  });

  it("never builds an index for a root it cannot watch", async () => {
    const { indexes } = watchedIndexes({ watchFails: true });
    const { disk, build } = diskBuild(["a.ts"]);

    await search(indexes, "", build);
    await indexes.idle();
    const entries = await search(indexes, "", build);

    expect({ entries, builds: disk.builds }).toEqual({ entries: null, builds: 0 });
  });

  it("releases an unused index and its watch without another search", async () => {
    vi.useFakeTimers();
    const { indexes, watch } = watchedIndexes({ idleMs: 1_000 });
    const { build } = diskBuild(["a.ts"]);
    await search(indexes, "", build);
    await indexes.idle();

    await vi.advanceTimersByTimeAsync(1_000);
    const afterRelease = await search(indexes, "", build);

    expect({ unwatched: watch.unwatched, afterRelease, roots: watch.roots }).toEqual({
      unwatched: 1,
      afterRelease: null,
      roots: ["/root", "/root"],
    });
  });

  it("walks instead of waiting on a rebuild that does not finish", async () => {
    vi.useFakeTimers();
    const { indexes, watch } = watchedIndexes();
    const { disk, build } = diskBuild(["a.ts"]);
    await search(indexes, "", build);
    await indexes.idle();
    disk.hold = new Promise(() => {});
    watch.changed();

    const pending = search(indexes, "", build);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBeNull();
  });

  it("retries a build that exceeded the entry cap", async () => {
    vi.useFakeTimers();
    const { indexes } = watchedIndexes();
    let listed: IndexedEntry[] | null = null;
    let builds = 0;
    const build = async () => {
      builds += 1;
      return listed;
    };
    await search(indexes, "", build);
    await indexes.idle();
    const oversized = await search(indexes, "", build);
    listed = [entry("a.ts")];
    vi.setSystemTime(Date.now() + 60_000);
    await search(indexes, "", build);
    await indexes.idle();

    const retried = await search(indexes, "", build);

    expect({ oversized, retried, builds }).toEqual({
      oversized: null,
      retried: [entry("a.ts")],
      builds: 2,
    });
  });

  it("answers from an unwatched index at once and refreshes it in the background", async () => {
    vi.useFakeTimers();
    const indexes = new PathIndexes();
    const { disk, build } = diskBuild(["a.ts"]);
    await search(indexes, "", build);
    await indexes.idle();
    disk.files = ["a.ts", "b.ts"];
    const fresh = await search(indexes, "", build);
    vi.setSystemTime(Date.now() + 1_000);
    const stale = await search(indexes, "", build);
    await indexes.idle();

    const refreshed = await search(indexes, "", build);

    expect({ fresh, stale, refreshed, builds: disk.builds }).toEqual({
      fresh: [entry("a.ts")],
      stale: [entry("a.ts")],
      refreshed: [entry("a.ts"), entry("b.ts")],
      builds: 2,
    });
  });
});
