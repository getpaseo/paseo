import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "./agent-storage.js";
import { FileAgentTimelineStore } from "./file-agent-timeline-store.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const user = (text: string) => ({ type: "user_message" as const, text });

async function storeDirectory(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "paseo-timeline-"));
}

function filePath(directory: string, agentId: string): string {
  return path.join(directory, `agent-${Buffer.from(agentId, "utf8").toString("base64url")}.json`);
}

function document(rows: AgentTimelineRow[], nextSeq: number) {
  return { version: 1, epoch: "epoch-1", nextSeq, rows };
}

describe("FileAgentTimelineStore", () => {
  it("loads a missing agent file as an empty timeline", async () => {
    const store = new FileAgentTimelineStore(await storeDirectory());
    expect(await store.getCommittedRows("agent")).toEqual([]);
  });

  it("loads legacy rows without turnId", async () => {
    const directory = await storeDirectory();
    await writeJsonFileAtomic(
      filePath(directory, "agent"),
      document([{ seq: 1, timestamp: "2026-01-01T00:00:00.000Z", item: user("old") }], 2),
    );

    expect(
      (await new FileAgentTimelineStore(directory).getCommittedRows("agent"))[0]?.turnId,
    ).toBeUndefined();
  });

  it("treats existing rows as incomplete until an atomic history snapshot commits", async () => {
    const directory = await storeDirectory();
    const store = new FileAgentTimelineStore(directory);
    const row = { seq: 1, timestamp: "2026-01-01T00:00:00.000Z", item: user("old") };

    await store.bulkInsert("agent", [row]);
    expect((await store.getCommittedSnapshot("agent")).historyComplete).toBe(false);

    await store.replaceCommittedSnapshot("agent", { rows: [row], historyComplete: true });
    expect(await new FileAgentTimelineStore(directory).getCommittedSnapshot("agent")).toEqual({
      rows: [row],
      historyComplete: true,
    });
  });

  it("round-trips supplied canonical rows without changing sequence or identity", async () => {
    const directory = await storeDirectory();
    const row: AgentTimelineRow = {
      seq: 7,
      timestamp: "2026-01-01T00:00:00.000Z",
      item: { type: "user_message", text: "hello", clientMessageId: "hello-client" },
      turnId: "turn-1",
      providerMessageId: "provider-hello",
    };

    await new FileAgentTimelineStore(directory).bulkInsert("agent", [row]);
    const reopened = new FileAgentTimelineStore(directory);
    expect(await reopened.getCommittedRows("agent")).toEqual([row]);
    expect((await reopened.fetchCommitted("agent", { limit: 0 })).window.nextSeq).toBe(8);
  });

  it("treats duplicate supplied rows as idempotent and rejects conflicting sequence reuse", async () => {
    const directory = await storeDirectory();
    let writeCount = 0;
    const store = new FileAgentTimelineStore(directory, {
      writeJson: async (file, value) => {
        writeCount += 1;
        await writeJsonFileAtomic(file, value);
      },
    });
    const row: AgentTimelineRow = {
      seq: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
      item: user("hello"),
      providerMessageId: "provider-hello",
      turnId: "turn-1",
    };

    await store.bulkInsert("agent", [row]);
    await store.bulkInsert("agent", [row]);
    expect(writeCount).toBe(1);
    await expect(store.bulkInsert("agent", [{ ...row, item: user("different") }])).rejects.toThrow(
      "Conflicting timeline row sequence 3",
    );
    expect(await store.getCommittedRows("agent")).toEqual([row]);
  });

  it("serializes concurrent mutations for one agent without losing rows", async () => {
    const store = new FileAgentTimelineStore(await storeDirectory());
    await Promise.all([
      store.appendCommitted("agent", user("one")),
      store.appendCommitted("agent", user("two")),
    ]);
    expect((await store.getCommittedRows("agent")).map((row) => row.seq)).toEqual([1, 2]);
  });

  it("updates an existing row exactly and rejects a missing row sequence", async () => {
    const store = new FileAgentTimelineStore(await storeDirectory());
    await store.bulkInsert("agent", [
      { seq: 1, timestamp: "2026-01-01T00:00:00.000Z", item: user("before") },
    ]);
    const replacement: AgentTimelineRow = {
      seq: 1,
      timestamp: "2026-01-01T00:00:01.000Z",
      item: user("after"),
      turnId: "turn-1",
      providerMessageId: "provider-1",
    };

    await store.updateCommittedRow("agent", replacement);
    expect(await store.getCommittedRows("agent")).toEqual([replacement]);
    await expect(store.updateCommittedRow("agent", { ...replacement, seq: 2 })).rejects.toThrow(
      "Cannot update missing timeline row sequence 2",
    );
  });

  it("recovers an agent mutation lane after a rejected write without committing the failed row", async () => {
    const directory = await storeDirectory();
    let writeCount = 0;
    const store = new FileAgentTimelineStore(directory, {
      writeJson: async (file, value) => {
        writeCount += 1;
        if (writeCount === 1) throw new Error("disk full");
        await writeJsonFileAtomic(file, value);
      },
    });

    await expect(store.appendCommitted("agent", user("lost"))).rejects.toThrow("disk full");
    expect(await store.getCommittedRows("agent")).toEqual([]);
    await expect(store.appendCommitted("agent", user("saved"))).resolves.toMatchObject({ seq: 1 });
    expect(await store.getCommittedRows("agent")).toEqual([
      expect.objectContaining({ seq: 1, item: user("saved") }),
    ]);
  });

  it("isolates corrupt files and failed mutation lanes to their own agent", async () => {
    const directory = await storeDirectory();
    await writeFile(filePath(directory, "broken"), "not json");
    const store = new FileAgentTimelineStore(directory, {
      writeJson: async (file, value) => {
        if (file === filePath(directory, "failing")) throw new Error("failing agent write");
        await writeJsonFileAtomic(file, value);
      },
    });

    await expect(store.getCommittedRows("broken")).rejects.toThrow();
    await expect(store.appendCommitted("valid", user("works"))).resolves.toMatchObject({ seq: 1 });
    await expect(store.appendCommitted("failing", user("fails"))).rejects.toThrow(
      "failing agent write",
    );
    await expect(store.appendCommitted("valid", user("still works"))).resolves.toMatchObject({
      seq: 2,
    });
  });

  it("does not serialize agent B behind a held agent A write", async () => {
    const directory = await storeDirectory();
    let releaseA!: () => void;
    const aWrite = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const store = new FileAgentTimelineStore(directory, {
      writeJson: async (file, value) => {
        if (file === filePath(directory, "agent-a")) await aWrite;
        await writeJsonFileAtomic(file, value);
      },
    });

    const appendA = store.appendCommitted("agent-a", user("held"));
    await expect(store.appendCommitted("agent-b", user("independent"))).resolves.toMatchObject({
      seq: 1,
    });
    releaseA();
    await expect(appendA).resolves.toMatchObject({ seq: 1 });
  });

  it.each([
    {
      name: "invalid timeline item",
      value: document([{ seq: 1, timestamp: "now", item: { type: "not-a-timeline-item" } }], 2),
    },
    {
      name: "out-of-order rows",
      value: document(
        [
          { seq: 2, timestamp: "now", item: user("two") },
          { seq: 1, timestamp: "now", item: user("one") },
        ],
        3,
      ),
    },
    {
      name: "next sequence at the committed maximum",
      value: document([{ seq: 1, timestamp: "now", item: user("one") }], 1),
    },
  ])("rejects persisted $name", async ({ value }) => {
    const directory = await storeDirectory();
    await writeJsonFileAtomic(filePath(directory, "agent"), value);
    await expect(new FileAgentTimelineStore(directory).getCommittedRows("agent")).rejects.toThrow();
  });

  it("writes outside AgentStorage discovery", async () => {
    const root = await storeDirectory();
    const agentStorageDirectory = path.join(root, "agents");
    const timelineDirectory = path.join(root, "timelines");
    const store = new FileAgentTimelineStore(timelineDirectory);

    await store.appendCommitted("agent", user("hello"));

    expect(await readdir(timelineDirectory)).toEqual(["agent-YWdlbnQ.json"]);
    expect(await new AgentStorage(agentStorageDirectory, createTestLogger()).list()).toEqual([]);
  });
});
