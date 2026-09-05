import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeFileAtomic } from "../atomic-file.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { SegmentedFileAgentTimelineStore } from "./segmented-file-agent-timeline-store.js";

const directories: string[] = [];

async function storeDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-segmented-timeline-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("SegmentedFileAgentTimelineStore", () => {
  it("matches in-memory fetch semantics across directions, cursors, and limits", async () => {
    const durable = new SegmentedFileAgentTimelineStore(await storeDirectory(), {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
    });
    const rows = Array.from({ length: 5 }, (_, index) => ({
      seq: index + 3,
      timestamp: "2026-08-31T12:00:00.000Z",
      item: { type: "user_message" as const, text: `row-${index + 3}` },
    }));
    await durable.bulkInsert("agent-1", rows);
    const epoch = (await durable.fetchCommitted("agent-1")).epoch;
    const memory = new InMemoryAgentTimelineStore();
    memory.initialize("agent-1", { rows, epoch, nextSeq: 8 });
    const options = [
      undefined,
      { direction: "tail" as const, limit: 0 },
      { direction: "before" as const, cursor: { epoch, seq: 6 }, limit: 2 },
      { direction: "before" as const, cursor: { epoch, seq: 3 }, limit: 2 },
      { direction: "after" as const, cursor: { epoch, seq: 4 }, limit: 2 },
      { direction: "after" as const, cursor: { epoch, seq: 7 }, limit: 2 },
      { direction: "after" as const, cursor: { epoch, seq: 0 }, limit: 2 },
      { direction: "before" as const, cursor: { epoch: "stale", seq: 6 }, limit: 2 },
      { direction: "after" as const, cursor: { epoch: "stale", seq: 6 }, limit: 0 },
    ];
    for (const option of options) {
      await expect(durable.fetchCommitted("agent-1", option)).resolves.toEqual(
        memory.fetch("agent-1", option),
      );
    }
  });

  it("pages across bounded segments after rebuilding the disposable cache", async () => {
    const directory = await storeDirectory();
    const store = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
    });

    for (const text of ["one", "two", "three", "four", "five"]) {
      await store.appendCommitted("agent-1", { type: "user_message", text });
    }

    const tail = await store.fetchCommitted("agent-1", { direction: "tail", limit: 2 });
    const reopened = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
    });
    const older = await reopened.fetchCommitted("agent-1", {
      direction: "before",
      cursor: { epoch: tail.epoch, seq: tail.rows[0]!.seq },
      limit: 3,
    });

    expect(tail).toMatchObject({
      epoch: expect.any(String),
      window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        { seq: 4, item: { type: "user_message", text: "four" } },
        { seq: 5, item: { type: "user_message", text: "five" } },
      ],
    });
    expect(older).toMatchObject({
      epoch: tail.epoch,
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
      hasOlder: false,
      hasNewer: true,
      rows: [
        { seq: 1, item: { type: "user_message", text: "one" } },
        { seq: 2, item: { type: "user_message", text: "two" } },
        { seq: 3, item: { type: "user_message", text: "three" } },
      ],
    });
  });

  it("keeps duplicate canonical rows idempotent and rejects sequence conflicts", async () => {
    const directory = await storeDirectory();
    const row = {
      seq: 7,
      timestamp: "2026-08-31T12:00:00.000Z",
      item: { type: "user_message" as const, text: "canonical" },
      turnId: "turn-1",
      providerMessageId: "provider-1",
    };
    const store = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
    });

    await store.bulkInsert("agent-1", [row]);
    await store.bulkInsert("agent-1", [row]);

    await expect(
      store.bulkInsert("agent-1", [{ ...row, item: { ...row.item, text: "conflict" } }]),
    ).rejects.toThrow("Conflicting timeline row sequence 7");
    await expect(
      new SegmentedFileAgentTimelineStore(directory).getCommittedRows("agent-1"),
    ).resolves.toEqual([row]);
  });

  it("deletes one agent cache without disturbing another", async () => {
    const directory = await storeDirectory();
    const store = new SegmentedFileAgentTimelineStore(directory);
    await store.appendCommitted("agent-a", { type: "user_message", text: "remove" });
    await store.appendCommitted("agent-b", { type: "user_message", text: "preserve" });

    await store.deleteAgent("agent-a");

    const reopened = new SegmentedFileAgentTimelineStore(directory);
    await expect(reopened.getCommittedRows("agent-a")).resolves.toEqual([]);
    await expect(reopened.getCommittedRows("agent-b")).resolves.toEqual([
      expect.objectContaining({ seq: 1, item: { type: "user_message", text: "preserve" } }),
    ]);
  });

  it("updates an existing canonical row and rejects a missing sequence", async () => {
    const directory = await storeDirectory();
    const store = new SegmentedFileAgentTimelineStore(directory);
    await store.bulkInsert("agent-1", [
      {
        seq: 3,
        timestamp: "2026-08-31T12:00:00.000Z",
        item: { type: "assistant_message", text: "before" },
      },
    ]);
    const replacement = {
      seq: 3,
      timestamp: "2026-08-31T12:00:01.000Z",
      item: { type: "assistant_message" as const, text: "after" },
      turnId: "turn-1",
      providerMessageId: "provider-1",
    };

    await store.updateCommittedRow("agent-1", replacement);

    await expect(
      new SegmentedFileAgentTimelineStore(directory).getCommittedRows("agent-1"),
    ).resolves.toEqual([replacement]);
    await expect(store.updateCommittedRow("agent-1", { ...replacement, seq: 4 })).rejects.toThrow(
      "Cannot update missing timeline row sequence 4",
    );
  });

  it("reads the latest item and assistant message across segment boundaries", async () => {
    const store = new SegmentedFileAgentTimelineStore(await storeDirectory(), {
      maxRowsPerSegment: 1,
      maxBytesPerSegment: 4_096,
    });
    await store.appendCommitted("agent-1", { type: "user_message", text: "question" });
    await store.appendCommitted("agent-1", { type: "assistant_message", text: "part one" });
    await store.appendCommitted("agent-1", { type: "assistant_message", text: " + part two" });

    await expect(store.getLatestCommittedSeq("agent-1")).resolves.toBe(3);
    await expect(store.getLastItem("agent-1")).resolves.toEqual({
      type: "assistant_message",
      text: " + part two",
    });
    await expect(store.getLastAssistantMessage("agent-1")).resolves.toBe("part one + part two");
  });

  it("rewrites only bounded files and removes superseded segment generations", async () => {
    const directory = await storeDirectory();
    const maxBytesPerSegment = 512;
    const writes: Array<{ file: string; bytes: number }> = [];
    const store = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment,
      writeFileAtomic: async (filePath, data) => {
        writes.push({ file: path.basename(filePath), bytes: Buffer.byteLength(data) });
        await writeFileAtomic(filePath, data);
      },
    });

    for (let index = 1; index <= 10; index += 1) {
      await store.appendCommitted("agent-1", {
        type: "user_message",
        text: `row-${index}-${"x".repeat(40)}`,
      });
    }

    const reopened = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment,
    });
    await reopened.getCommittedRows("agent-1");
    await reopened.collectGarbage("agent-1");

    const agentDirectory = path.join(
      directory,
      `agent-${Buffer.from("agent-1", "utf8").toString("base64url")}`,
    );
    const files = await readdir(agentDirectory);
    const segmentFiles = files.filter((file) => file.startsWith("segment-"));
    const segmentBytes = await Promise.all(
      segmentFiles.map(async (file) =>
        Buffer.byteLength(await readFile(path.join(agentDirectory, file))),
      ),
    );

    expect(segmentFiles).toHaveLength(5);
    expect(Math.max(...segmentBytes)).toBeLessThanOrEqual(maxBytesPerSegment);
    expect(
      Math.max(
        ...writes.filter(({ file }) => file.startsWith("segment-")).map(({ bytes }) => bytes),
      ),
    ).toBeLessThanOrEqual(maxBytesPerSegment);
    expect(
      Math.max(...writes.filter(({ file }) => file === "manifest.json").map(({ bytes }) => bytes)),
    ).toBeLessThan(512);
    expect(
      Buffer.byteLength(await readFile(path.join(agentDirectory, "manifest.json"))),
    ).toBeLessThan(512);
  });

  it("reads only the segments touched by tail, before, and after pages", async () => {
    const directory = await storeDirectory();
    const writer = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
    });
    for (let index = 1; index <= 100; index += 1) {
      await writer.appendCommitted("agent-1", {
        type: "user_message",
        text: `row-${index}`,
      });
    }

    let segmentReads = 0;
    const store = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
      onSegmentRead: (filePath) => {
        if (path.basename(filePath).startsWith("segment-")) segmentReads += 1;
      },
    });

    const tail = await store.fetchCommitted("agent-1", { direction: "tail", limit: 2 });
    expect(tail.rows.map((row) => row.seq)).toEqual([99, 100]);
    expect(segmentReads).toBe(1);

    segmentReads = 0;
    const before = await store.fetchCommitted("agent-1", {
      direction: "before",
      cursor: { epoch: tail.epoch, seq: 99 },
      limit: 2,
    });
    expect(before.rows.map((row) => row.seq)).toEqual([97, 98]);
    expect(segmentReads).toBe(1);

    segmentReads = 0;
    const after = await store.fetchCommitted("agent-1", {
      direction: "after",
      cursor: { epoch: tail.epoch, seq: 98 },
      limit: 2,
    });
    expect(after.rows.map((row) => row.seq)).toEqual([99, 100]);
    expect(segmentReads).toBe(1);

    segmentReads = 0;
    const farAfter = await store.fetchCommitted("agent-1", {
      direction: "after",
      cursor: { epoch: tail.epoch, seq: 2 },
      limit: 2,
    });
    expect(farAfter.rows.map((row) => row.seq)).toEqual([3, 4]);
    expect(segmentReads).toBe(1);

    segmentReads = 0;
    const pageOne = await store.fetchCommitted("agent-1", {
      direction: "before",
      cursor: { epoch: tail.epoch, seq: 51 },
      limit: 2,
    });
    const pageTwo = await store.fetchCommitted("agent-1", {
      direction: "before",
      cursor: { epoch: tail.epoch, seq: pageOne.rows[0]!.seq },
      limit: 2,
    });
    expect(pageOne.rows.map((row) => row.seq)).toEqual([49, 50]);
    expect(pageTwo.rows.map((row) => row.seq)).toEqual([47, 48]);
    expect(segmentReads).toBe(2);
  });

  it("updates only the bounded segment containing a canonical row", async () => {
    const directory = await storeDirectory();
    const writer = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
    });
    for (let index = 1; index <= 6; index += 1) {
      await writer.appendCommitted("agent-1", {
        type: "assistant_message",
        text: `before-${index}`,
      });
    }

    const writes: string[] = [];
    const store = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
      writeFileAtomic: async (filePath, data) => {
        writes.push(path.basename(filePath));
        await writeFileAtomic(filePath, data);
      },
    });
    const row = (await store.getCommittedRows("agent-1"))[0]!;

    await store.updateCommittedRow("agent-1", {
      ...row,
      item: { type: "assistant_message", text: "after-1" },
    });

    expect(writes.filter((file) => file.startsWith("segment-"))).toHaveLength(1);
    expect(writes.filter((file) => file === "manifest.json")).toHaveLength(1);
    await expect(
      new SegmentedFileAgentTimelineStore(directory).getCommittedRows("agent-1"),
    ).resolves.toEqual([
      expect.objectContaining({ seq: 1, item: { type: "assistant_message", text: "after-1" } }),
      ...Array.from({ length: 5 }, (_, index) =>
        expect.objectContaining({
          seq: index + 2,
          item: { type: "assistant_message", text: `before-${index + 2}` },
        }),
      ),
    ]);
  });

  it("keeps the last manifest visible after failed publication and cleans the orphan on recovery", async () => {
    const directory = await storeDirectory();
    let failManifest = false;
    const store = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
      writeFileAtomic: async (filePath, data) => {
        if (path.basename(filePath) === "manifest.json" && failManifest) {
          failManifest = false;
          throw new Error("manifest unavailable");
        }
        await writeFileAtomic(filePath, data);
      },
    });
    await store.appendCommitted("agent-1", { type: "user_message", text: "committed" });

    failManifest = true;
    await expect(
      store.appendCommitted("agent-1", { type: "user_message", text: "not committed" }),
    ).rejects.toThrow("manifest unavailable");
    await expect(
      new SegmentedFileAgentTimelineStore(directory).getCommittedRows("agent-1"),
    ).resolves.toEqual([
      expect.objectContaining({ seq: 1, item: { type: "user_message", text: "committed" } }),
    ]);

    await expect(
      store.appendCommitted("agent-1", { type: "user_message", text: "recovered" }),
    ).resolves.toMatchObject({ seq: 2 });
    const agentDirectory = path.join(
      directory,
      `agent-${Buffer.from("agent-1", "utf8").toString("base64url")}`,
    );
    const recovered = new SegmentedFileAgentTimelineStore(directory);
    await recovered.getCommittedRows("agent-1");
    await recovered.collectGarbage("agent-1");
    expect(
      (await readdir(agentDirectory)).filter((file) => file.startsWith("segment-")),
    ).toHaveLength(1);
    await expect(
      new SegmentedFileAgentTimelineStore(directory).getCommittedRows("agent-1"),
    ).resolves.toEqual([
      expect.objectContaining({ seq: 1, item: { type: "user_message", text: "committed" } }),
      expect.objectContaining({ seq: 2, item: { type: "user_message", text: "recovered" } }),
    ]);
  });

  it("does not serialize agent B behind a held agent A publication", async () => {
    const directory = await storeDirectory();
    let releaseAgentA!: () => void;
    let markAgentAStarted!: () => void;
    const agentAStarted = new Promise<void>((resolve) => {
      markAgentAStarted = resolve;
    });
    const holdAgentA = new Promise<void>((resolve) => {
      releaseAgentA = resolve;
    });
    const store = new SegmentedFileAgentTimelineStore(directory, {
      writeFileAtomic: async (filePath, data) => {
        const agentDirectory = path.basename(path.dirname(filePath));
        if (agentDirectory === `agent-${Buffer.from("agent-a").toString("base64url")}`) {
          markAgentAStarted();
          await holdAgentA;
        }
        await writeFileAtomic(filePath, data);
      },
    });

    const appendAgentA = store.appendCommitted("agent-a", {
      type: "user_message",
      text: "held",
    });
    await agentAStarted;
    await expect(
      store.appendCommitted("agent-b", { type: "user_message", text: "independent" }),
    ).resolves.toMatchObject({ seq: 1 });
    releaseAgentA();
    await expect(appendAgentA).resolves.toMatchObject({ seq: 1 });
  });

  it("keeps repeated single-row bulk inserts bounded as history grows", async () => {
    const directory = await storeDirectory();
    let segmentReads = 0;
    const writes: string[] = [];
    const store = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
      onSegmentRead: (filePath) => {
        if (path.basename(filePath).startsWith("segment-")) segmentReads += 1;
      },
      writeFileAtomic: async (filePath, data) => {
        writes.push(path.basename(filePath));
        await writeFileAtomic(filePath, data);
      },
    });

    for (let seq = 1; seq <= 40; seq += 1) {
      segmentReads = 0;
      writes.length = 0;
      await store.bulkInsert("agent-1", [
        {
          seq,
          timestamp: `2026-08-31T12:00:${String(seq).padStart(2, "0")}.000Z`,
          item: { type: "user_message", text: `row-${seq}` },
        },
      ]);
      expect(segmentReads).toBeLessThanOrEqual(1);
      expect(writes.filter((file) => file.startsWith("segment-"))).toHaveLength(1);
      expect(writes.filter((file) => file === "manifest.json")).toHaveLength(1);
    }
  });

  it("keeps a published segment available to an in-flight reader", async () => {
    const directory = await storeDirectory();
    const writer = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
    });
    await writer.appendCommitted("agent-1", { type: "user_message", text: "one" });

    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let held = false;
    const reader = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
      beforeSegmentRead: async () => {
        if (held) return;
        held = true;
        markReadStarted();
        await heldRead;
      },
    });

    const read = reader.fetchCommitted("agent-1", { direction: "tail", limit: 1 });
    await readStarted;
    await writer.appendCommitted("agent-1", { type: "user_message", text: "two" });
    await new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
    }).getCommittedRows("agent-1");
    releaseRead();

    await expect(read).resolves.toMatchObject({
      rows: [{ seq: 1, item: { type: "user_message", text: "one" } }],
    });
  });

  it("removes unreachable lower generations during explicit garbage collection", async () => {
    const directory = await storeDirectory();
    const writer = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 2,
      maxBytesPerSegment: 4_096,
    });
    await writer.appendCommitted("agent-1", { type: "user_message", text: "one" });
    await writer.appendCommitted("agent-1", { type: "user_message", text: "two" });
    const agentDirectory = path.join(
      directory,
      `agent-${Buffer.from("agent-1", "utf8").toString("base64url")}`,
    );
    await writer.collectGarbage("agent-1");
    const activeSegment = (await readdir(agentDirectory)).find((file) =>
      file.startsWith("segment-"),
    )!;
    await copyFile(
      path.join(agentDirectory, activeSegment),
      path.join(agentDirectory, "segment-1-unreachable.json"),
    );
    expect(
      (await readdir(agentDirectory)).filter((file) => file.startsWith("segment-")),
    ).toHaveLength(2);

    const reopened = new SegmentedFileAgentTimelineStore(directory);
    await reopened.getCommittedRows("agent-1");
    await reopened.collectGarbage("agent-1");

    expect(
      (await readdir(agentDirectory)).filter((file) => file.startsWith("segment-")),
    ).toHaveLength(1);
  });

  it.each(["same instance", "cross instance"] as const)(
    "keeps unpublished generation files while %s garbage collection contends",
    async (collectorKind) => {
      const directory = await storeDirectory();
      const manifestHeld = deferred();
      const releaseManifest = deferred();
      const lockContended = deferred();
      let holdNextManifest = false;
      const writer = new SegmentedFileAgentTimelineStore(directory, {
        maxRowsPerSegment: 2,
        maxBytesPerSegment: 4_096,
        onMutationLockContention: () => lockContended.resolve(),
        writeFileAtomic: async (filePath, data) => {
          if (path.basename(filePath) === "manifest.json" && holdNextManifest) {
            holdNextManifest = false;
            manifestHeld.resolve();
            await releaseManifest.promise;
          }
          await writeFileAtomic(filePath, data);
        },
      });
      await writer.appendCommitted("agent-1", { type: "user_message", text: "one" });
      holdNextManifest = true;
      const append = writer.appendCommitted("agent-1", { type: "user_message", text: "two" });
      await manifestHeld.promise;
      const agentDirectory = path.join(
        directory,
        `agent-${Buffer.from("agent-1", "utf8").toString("base64url")}`,
      );
      const pendingFiles = (await readdir(agentDirectory)).filter(
        (file) => file.startsWith("segment-2-") || file.startsWith("catalog-"),
      );
      const collector =
        collectorKind === "same instance"
          ? writer
          : new SegmentedFileAgentTimelineStore(directory, {
              onMutationLockContention: () => lockContended.resolve(),
            });
      const garbageCollection = collector.collectGarbage("agent-1");
      await lockContended.promise;

      expect(pendingFiles).not.toHaveLength(0);
      await expect(readExistingFiles(agentDirectory, pendingFiles)).resolves.toEqual(pendingFiles);

      releaseManifest.resolve();
      await append;
      await garbageCollection;
      await expect(collector.getCommittedRows("agent-1")).resolves.toEqual([
        expect.objectContaining({ seq: 1, item: { type: "user_message", text: "one" } }),
        expect.objectContaining({ seq: 2, item: { type: "user_message", text: "two" } }),
      ]);
    },
  );

  it("fails closed when a cataloged segment is missing", async () => {
    const missingDirectory = await storeDirectory();
    const missingWriter = new SegmentedFileAgentTimelineStore(missingDirectory);
    await missingWriter.appendCommitted("agent-1", { type: "user_message", text: "one" });
    const missingAgentDirectory = path.join(
      missingDirectory,
      `agent-${Buffer.from("agent-1", "utf8").toString("base64url")}`,
    );
    await missingWriter.collectGarbage("agent-1");
    const missingSegment = (await readdir(missingAgentDirectory)).find((file) =>
      file.startsWith("segment-"),
    )!;
    await rm(path.join(missingAgentDirectory, missingSegment));
    await expect(
      new SegmentedFileAgentTimelineStore(missingDirectory).getCommittedRows("agent-1"),
    ).rejects.toThrow("Corrupt timeline cache: missing segment");
  });

  it("reads backward only until the last assistant-message boundary", async () => {
    const directory = await storeDirectory();
    const writer = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 1,
      maxBytesPerSegment: 4_096,
    });
    for (let seq = 1; seq <= 98; seq += 1) {
      await writer.appendCommitted("agent-1", { type: "user_message", text: `row-${seq}` });
    }
    await writer.appendCommitted("agent-1", { type: "assistant_message", text: "part one" });
    await writer.appendCommitted("agent-1", { type: "assistant_message", text: " + part two" });

    let segmentReads = 0;
    const reader = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 1,
      maxBytesPerSegment: 4_096,
      onSegmentRead: (filePath) => {
        if (path.basename(filePath).startsWith("segment-")) segmentReads += 1;
      },
    });
    await expect(reader.getLastAssistantMessage("agent-1")).resolves.toBe("part one + part two");
    expect(segmentReads).toBe(2);
  });

  it("uses assistant summary metadata across a long non-assistant tail", async () => {
    const directory = await storeDirectory();
    const writer = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 1,
      maxBytesPerSegment: 4_096,
    });
    await writer.appendCommitted("agent-1", { type: "assistant_message", text: "answer" });
    for (let seq = 2; seq <= 100; seq += 1) {
      await writer.appendCommitted("agent-1", { type: "user_message", text: `tail-${seq}` });
    }
    for (let seq = 1; seq <= 100; seq += 1) {
      await writer.appendCommitted("agent-2", { type: "user_message", text: `row-${seq}` });
    }
    let segmentReads = 0;
    const reader = new SegmentedFileAgentTimelineStore(directory, {
      maxRowsPerSegment: 1,
      maxBytesPerSegment: 4_096,
      onSegmentRead: () => {
        segmentReads += 1;
      },
    });

    await expect(reader.getLastAssistantMessage("agent-1")).resolves.toBe("answer");
    expect(segmentReads).toBe(1);
    segmentReads = 0;
    await expect(reader.getLastAssistantMessage("agent-2")).resolves.toBeNull();
    expect(segmentReads).toBe(0);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function readExistingFiles(directory: string, files: string[]): Promise<string[]> {
  await Promise.all(files.map(async (file) => await readFile(path.join(directory, file), "utf8")));
  return files;
}
