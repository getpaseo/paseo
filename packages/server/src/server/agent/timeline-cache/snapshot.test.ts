import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PagedTimelineCatalog } from "./paged-catalog.js";
import { TimelineSnapshotManager } from "./snapshot.js";
import type { TimelineManifestFields } from "./snapshot.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("TimelineSnapshotManager", () => {
  it("reopens the manifest-owned root after publication and collects only unreachable files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-snapshot-"));
    directories.push(directory);
    const catalog = new PagedTimelineCatalog(directory, { fanout: 2, maxPageBytes: 2_048 });
    const manager = new TimelineSnapshotManager(directory, catalog, { maxManifestBytes: 2_048 });
    const firstRoot = await catalog.append(null, descriptor(1));
    await publish(manager, manifestFields(firstRoot, 1));
    const secondRoot = await catalog.append(firstRoot, descriptor(2));
    await publish(manager, manifestFields(secondRoot, 2));

    const reopened = new TimelineSnapshotManager(directory, catalog, { maxManifestBytes: 2_048 });
    const lease = await reopened.load();
    expect(lease.manifest).toMatchObject({ generation: 2, maxSeq: 2, root: secondRoot });
    lease.release();
    expect(
      (await readdir(directory)).filter((file) => file.startsWith("catalog-")),
    ).not.toHaveLength(1);

    await reopened.collectGarbage();

    const reachable = await catalog.collectReachable(secondRoot);
    expect((await readdir(directory)).filter((file) => file.startsWith("catalog-"))).toHaveLength(
      reachable.pageFiles.size,
    );
  });

  it("retries a load when publication changes generation before its snapshot lease", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-snapshot-"));
    directories.push(directory);
    const catalog = new PagedTimelineCatalog(directory, { fanout: 2, maxPageBytes: 2_048 });
    const writer = new TimelineSnapshotManager(directory, catalog, { maxManifestBytes: 2_048 });
    const firstRoot = await catalog.append(null, descriptor(1));
    await publish(writer, manifestFields(firstRoot, 1));
    let releaseFirstRead!: () => void;
    let markFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      markFirstRead = resolve;
    });
    const holdFirstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let reads = 0;
    const loader = new TimelineSnapshotManager(directory, catalog, {
      maxManifestBytes: 2_048,
      afterManifestRead: async () => {
        reads += 1;
        if (reads !== 1) return;
        markFirstRead();
        await holdFirstRead;
      },
    });

    const loading = loader.load();
    await firstRead;
    const secondRoot = await catalog.append(firstRoot, descriptor(2));
    await publish(writer, manifestFields(secondRoot, 2));
    await writer.collectGarbage();
    releaseFirstRead();

    const loaded = await loading;
    expect(loaded.manifest).toMatchObject({ generation: 2, root: secondRoot });
    expect(reads).toBeGreaterThanOrEqual(3);
    loaded.release();
  });

  it("allows only one cross-instance publisher from the same generation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-snapshot-"));
    directories.push(directory);
    const catalog = new PagedTimelineCatalog(directory, { fanout: 2, maxPageBytes: 2_048 });
    const first = new TimelineSnapshotManager(directory, catalog, { maxManifestBytes: 2_048 });
    const second = new TimelineSnapshotManager(directory, catalog, { maxManifestBytes: 2_048 });
    const root = await catalog.append(null, descriptor(1));
    await publish(first, manifestFields(root, 1));
    const left = await catalog.append(root, descriptor(2));
    const right = await catalog.append(root, {
      ...descriptor(2),
      file: "segment-2-ffffffff-0000-4000-8000-000000000000.json",
    });

    const firstExpected = await first.load();
    const secondExpected = await second.load();
    const results = await Promise.allSettled([
      first.publish(firstExpected.manifest, async () => manifestFields(left, 2)),
      second.publish(secondExpected.manifest, async () => manifestFields(right, 2)),
    ]);
    firstExpected.release();
    secondExpected.release();

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const loaded = await first.load();
    expect([left.file, right.file]).toContain(loaded.manifest.root?.file);
    loaded.release();
  });

  it.each(["epoch", "root"] as const)(
    "rejects a same-generation %s mismatch before building unpublished files",
    async (changedField) => {
      const directory = await mkdtemp(path.join(tmpdir(), "paseo-snapshot-"));
      directories.push(directory);
      const catalog = new PagedTimelineCatalog(directory, { fanout: 2, maxPageBytes: 2_048 });
      const manager = new TimelineSnapshotManager(directory, catalog, { maxManifestBytes: 2_048 });
      const root = await catalog.append(null, descriptor(1));
      await publish(manager, manifestFields(root, 1));
      const expected = await manager.load();
      const replacementRoot = await catalog.append(root, descriptor(2));
      const replacement =
        changedField === "epoch"
          ? { ...expected.manifest, epoch: "replacement-epoch" }
          : {
              ...expected.manifest,
              nextSeq: 3,
              maxSeq: 2,
              root: replacementRoot,
            };
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify(replacement));
      let built = false;

      await expect(
        manager.publish(expected.manifest, async () => {
          built = true;
          return manifestFields(replacementRoot, 2);
        }),
      ).rejects.toThrow("Timeline snapshot changed");
      expect(built).toBe(false);
      expected.release();
    },
  );

  it("rejects an escaping manifest root before catalog path resolution", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-snapshot-"));
    directories.push(directory);
    const summary = descriptor(1).summary;
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        version: 1,
        generation: 1,
        epoch: "epoch-1",
        nextSeq: 2,
        minSeq: 1,
        maxSeq: 1,
        root: { file: "../escape.json", minSeq: 1, maxSeq: 1, summary },
      }),
    );
    const catalog = new PagedTimelineCatalog(directory);
    await expect(new TimelineSnapshotManager(directory, catalog).load()).rejects.toThrow(
      "Invalid catalog reference",
    );
  });
});

function manifestFields(root: Awaited<ReturnType<PagedTimelineCatalog["append"]>>, maxSeq: number) {
  return { epoch: "epoch-1", nextSeq: maxSeq + 1, minSeq: 1, maxSeq, root };
}

function descriptor(seq: number) {
  return {
    file: `segment-${seq}-${String(seq).padStart(8, "0")}-0000-4000-8000-000000000000.json`,
    generation: seq,
    minSeq: seq,
    maxSeq: seq,
    summary: {
      minSeq: seq,
      maxSeq: seq,
      firstItemType: "user_message",
      lastItemType: "user_message",
      trailingAssistantStartSeq: null,
      lastAssistantRun: null,
    },
  };
}

async function publish(
  manager: TimelineSnapshotManager,
  fields: TimelineManifestFields,
): Promise<void> {
  const lease = await manager.load();
  try {
    await manager.publish(lease.manifest, async () => fields);
  } finally {
    lease.release();
  }
}
