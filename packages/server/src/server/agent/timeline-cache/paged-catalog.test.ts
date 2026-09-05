import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PagedTimelineCatalog } from "./paged-catalog.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("PagedTimelineCatalog", () => {
  it("copy-on-write appends and locates far ranges through bounded fanout pages", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-catalog-"));
    directories.push(directory);
    let pageReads = 0;
    const catalog = new PagedTimelineCatalog(directory, {
      fanout: 3,
      maxPageBytes: 2_048,
      onPageRead: () => {
        pageReads += 1;
      },
    });
    let root = null;
    for (let seq = 1; seq <= 100; seq += 1) root = await catalog.append(root, descriptor(seq));

    pageReads = 0;
    await expect(catalog.find(root, 2)).resolves.toMatchObject({ minSeq: 2, maxSeq: 2 });
    expect(pageReads).toBeLessThanOrEqual(6);
    pageReads = 0;
    await expect(catalog.find(root, 99)).resolves.toMatchObject({ minSeq: 99, maxSeq: 99 });
    expect(pageReads).toBeLessThanOrEqual(6);
  });

  it("pages before and after a far cursor without reading unrelated catalog branches", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-catalog-"));
    directories.push(directory);
    let pageReads = 0;
    const catalog = new PagedTimelineCatalog(directory, {
      fanout: 3,
      maxPageBytes: 2_048,
      onPageRead: () => {
        pageReads += 1;
      },
    });
    let root = null;
    for (let seq = 1; seq <= 100; seq += 1) root = await catalog.append(root, descriptor(seq));

    pageReads = 0;
    await expect(catalog.before(root, 51, 2)).resolves.toMatchObject([
      { minSeq: 49 },
      { minSeq: 50 },
    ]);
    expect(pageReads).toBeLessThanOrEqual(7);
    pageReads = 0;
    await expect(catalog.after(root, 50, 2)).resolves.toMatchObject([
      { minSeq: 51 },
      { minSeq: 52 },
    ]);
    expect(pageReads).toBeLessThanOrEqual(7);
  });

  it("replaces one descriptor with copy-on-write pages", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-catalog-"));
    directories.push(directory);
    const catalog = new PagedTimelineCatalog(directory, { fanout: 3, maxPageBytes: 2_048 });
    let root = null;
    for (let seq = 1; seq <= 12; seq += 1) root = await catalog.append(root, descriptor(seq));
    const replacement = {
      ...descriptor(6),
      file: "segment-20-ffffffff-0000-4000-8000-000000000000.json",
      generation: 20,
    };

    const replaced = await catalog.replace(root, 6, replacement);

    await expect(catalog.find(replaced, 6)).resolves.toEqual(replacement);
    await expect(catalog.find(root, 6)).resolves.toEqual(descriptor(6));
  });

  it("rejects path escapes, cycles, and excessive depth before opening descendants", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-catalog-"));
    directories.push(directory);
    const summary = descriptor(1).summary;
    const escaped = { file: "../escape.json", minSeq: 1, maxSeq: 1, summary };
    await expect(new PagedTimelineCatalog(directory).find(escaped, 1)).rejects.toThrow(
      "Invalid catalog reference",
    );

    const cycleFile = "catalog-00000000-0000-4000-8000-000000000001.json";
    const cycleRef = { file: cycleFile, minSeq: 1, maxSeq: 1, summary };
    await writeFile(
      path.join(directory, cycleFile),
      JSON.stringify({ version: 1, kind: "internal", children: [cycleRef] }),
    );
    await expect(new PagedTimelineCatalog(directory).find(cycleRef, 1)).rejects.toThrow(
      "Catalog page cycle detected",
    );

    const files = [2, 3, 4].map(
      (suffix) => `catalog-00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}.json`,
    );
    const refs = files.map((file) => ({ file, minSeq: 1, maxSeq: 1, summary }));
    await writeFile(
      path.join(directory, files[2]!),
      JSON.stringify({ version: 1, kind: "leaf", entries: [descriptor(1)] }),
    );
    await writeFile(
      path.join(directory, files[1]!),
      JSON.stringify({ version: 1, kind: "internal", children: [refs[2]] }),
    );
    await writeFile(
      path.join(directory, files[0]!),
      JSON.stringify({ version: 1, kind: "internal", children: [refs[1]] }),
    );
    await expect(
      new PagedTimelineCatalog(directory, { maxTraversalDepth: 2 }).find(refs[0]!, 1),
    ).rejects.toThrow("Catalog traversal depth exceeded");
  });
});

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
