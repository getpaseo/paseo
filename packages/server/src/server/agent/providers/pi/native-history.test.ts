import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  mapPiNativeHistoryEvents,
  readPiNativeHistory,
  selectPiNativeHistoryEventsAfter,
} from "./native-history.js";

async function writeNativeHistory(lines: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-native-history-"));
  const file = path.join(root, "sessions", "project", "native.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

describe("Pi native history", () => {
  test("maps native JSONL through the shared Pi history mapper with native entry ids", async () => {
    const file = await writeNativeHistory([
      {
        type: "session",
        id: "native-pi-session",
        timestamp: "2026-06-09T00:00:00.000Z",
        cwd: "/workspace/project",
      },
      {
        type: "message",
        id: "user-1",
        timestamp: "2026-06-09T00:00:01.000Z",
        message: { role: "user", content: "repeat" },
      },
      {
        type: "message",
        id: "assistant-1",
        timestamp: "2026-06-09T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "one" }] },
      },
      {
        type: "message",
        id: "user-2",
        timestamp: "2026-06-09T00:00:03.000Z",
        message: { role: "user", content: "repeat" },
      },
    ]);

    const history = await readPiNativeHistory(file);

    expect(history).toMatchObject({
      sessionId: "native-pi-session",
      cwd: "/workspace/project",
      latestEntryId: "user-2",
    });
    expect(
      mapPiNativeHistoryEvents(history, "pi").map(({ entryId, event }) => ({ entryId, event })),
    ).toEqual([
      {
        entryId: "user-1",
        event: {
          type: "timeline",
          provider: "pi",
          timestamp: "2026-06-09T00:00:01.000Z",
          item: { type: "user_message", text: "repeat", messageId: "user-1" },
        },
      },
      {
        entryId: "assistant-1",
        event: {
          type: "timeline",
          provider: "pi",
          timestamp: "2026-06-09T00:00:02.000Z",
          item: { type: "assistant_message", text: "one", messageId: "assistant-1" },
        },
      },
      {
        entryId: "user-2",
        event: {
          type: "timeline",
          provider: "pi",
          timestamp: "2026-06-09T00:00:03.000Z",
          item: { type: "user_message", text: "repeat", messageId: "user-2" },
        },
      },
    ]);
  });

  test("selects only entries after the last synced native id", async () => {
    const file = await writeNativeHistory([
      { type: "session", id: "native-pi-session", cwd: "/workspace/project" },
      { type: "message", id: "user-1", message: { role: "user", content: "before" } },
      {
        type: "message",
        id: "assistant-1",
        message: { role: "assistant", content: [{ type: "text", text: "middle" }] },
      },
      { type: "message", id: "user-2", message: { role: "user", content: "after" } },
    ]);
    const history = await readPiNativeHistory(file);

    expect(
      selectPiNativeHistoryEventsAfter(mapPiNativeHistoryEvents(history, "pi"), "assistant-1").map(
        ({ entryId }) => entryId,
      ),
    ).toEqual(["user-2"]);
    expect(() =>
      selectPiNativeHistoryEventsAfter(mapPiNativeHistoryEvents(history, "pi"), "missing-entry"),
    ).toThrow("Native Pi history no longer contains synced entry missing-entry");
  });
});
