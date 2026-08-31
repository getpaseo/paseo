import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildRowSegment,
  combineTimelineSummaries,
  encodeRowSegment,
  readRowSegment,
} from "./row-segment.js";

describe("row segments", () => {
  it("records an address for the latest assistant run without scanning older rows", () => {
    const left = buildRowSegment([
      row(1, "user_message", "question"),
      row(2, "assistant_message", "part one"),
    ]);
    const right = buildRowSegment([
      row(3, "assistant_message", "part two"),
      row(4, "user_message", "tool result"),
    ]);

    expect(combineTimelineSummaries(left.summary, right.summary)).toEqual({
      minSeq: 1,
      maxSeq: 4,
      firstItemType: "user_message",
      lastItemType: "user_message",
      trailingAssistantStartSeq: null,
      lastAssistantRun: { startSeq: 2, endSeq: 3 },
    });
  });

  it("enforces the encoded segment limit on write and before read allocation", async () => {
    const segment = buildRowSegment([row(1, "user_message", "x".repeat(256))]);
    expect(() => encodeRowSegment(segment, 64)).toThrow("segment exceeds the 64-byte limit");
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-row-segment-"));
    const file = path.join(directory, "segment.json");
    await writeFile(file, JSON.stringify(segment));
    await expect(readRowSegment(file, 64)).rejects.toThrow("JSON file exceeds the 64-byte limit");
    await rm(directory, { recursive: true });
  });
});

function row(seq: number, type: "user_message" | "assistant_message", text: string) {
  return { seq, timestamp: "2026-08-31T12:00:00.000Z", item: { type, text } };
}
