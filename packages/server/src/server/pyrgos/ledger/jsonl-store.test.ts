import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonlLedgerStore, readLedgerFile } from "./jsonl-store.js";

const row = {
  id: "a1",
  state: "draft",
  item: "x",
  scope: null,
  project: null,
  doneCriteria: null,
  transcriptRef: null,
  launchId: null,
  announcedAt: null,
  launchedAt: null,
  launchError: null,
  dropReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("readLedgerFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ledger-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a later append valid after a partial final write", async () => {
    const path = join(dir, "t.ledger.jsonl");
    await writeFile(path, `${JSON.stringify(row).slice(0, 30)}`);
    createJsonlLedgerStore(path).append({ ...row, id: "b2" } as never);
    expect(readLedgerFile(path).map((item) => item.id)).toEqual(["b2"]);
  });

  it("skips a truncated row and keeps the valid items", async () => {
    const path = join(dir, "s.ledger.jsonl");
    const good = JSON.stringify(row);
    await writeFile(path, `${good}\n{"id":"a2","state":"dra\n${good.slice(0, 20)}`);
    const items = readLedgerFile(path);
    expect(items.map((item) => item.id)).toEqual(["a1"]);
  });
});
