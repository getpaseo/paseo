import { describe, expect, it } from "vitest";
import { DEFAULT_ITEM_TIMES_PREFERENCES } from "@/hooks/use-settings/storage";
import type { StreamItem } from "@/types/stream";
import {
  START_ITEM_TIME_CURSOR,
  continuesAssistantMessage,
  groupItemTime,
  itemTimeKind,
  resolveItemTimeSideWidth,
  showsItemTime,
  timeHistory,
  timeItems,
  type ItemTime,
} from "./item-times";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 28, 12, 0, seconds));

function user(id: string, seconds: number): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: at(seconds) };
}
function assistant(id: string, seconds: number, messageId?: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: at(seconds),
    ...(messageId ? { messageId } : {}),
  };
}
function thought(id: string, seconds: number): StreamItem {
  return { kind: "thought", id, text: id, timestamp: at(seconds), status: "ready" };
}
function tool(id: string, seconds: number): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: at(seconds),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "true" },
      },
    },
  };
}

function timesOf(items: StreamItem[]): Map<string, ItemTime> {
  const times = new Map<string, ItemTime>();
  timeItems(items, START_ITEM_TIME_CURSOR, times);
  return times;
}

describe("item times", () => {
  it("times each step from the end of the row before it", () => {
    const times = timesOf([user("u", 0), thought("t", 4), tool("c", 10), assistant("a", 13, "m1")]);
    expect(times.get("u")).toEqual({ at: at(0), tookMs: null });
    expect(times.get("t")?.tookMs).toBe(4_000);
    expect(times.get("c")?.tookMs).toBe(6_000);
    expect(times.get("a")?.tookMs).toBe(3_000);
  });

  it("gives the user's own messages a time but no duration", () => {
    const times = timesOf([assistant("a", 0, "m1"), user("u", 30)]);
    expect(times.get("u")).toEqual({ at: at(30), tookMs: null });
  });

  it("times the pieces of one message in a row from before the first piece", () => {
    const times = timesOf([tool("c", 0), assistant("a1", 5, "m1"), assistant("a2", 9, "m1")]);
    expect(times.get("a1")?.tookMs).toBe(5_000);
    expect(times.get("a2")?.tookMs).toBe(9_000);
  });

  it("starts a new step for a new message", () => {
    const times = timesOf([assistant("a1", 5, "m1"), assistant("a2", 9, "m2")]);
    expect(times.get("a2")?.tookMs).toBe(4_000);
  });

  it("shows no duration when two times are out of order", () => {
    const times = timesOf([tool("c1", 20), tool("c2", 15)]);
    expect(times.get("c2")).toEqual({ at: at(15), tookMs: null });
  });

  it("skips a row without a usable time and times the next one across it", () => {
    const broken = { ...tool("x", 0), timestamp: new Date(Number.NaN) };
    const times = timesOf([tool("c1", 2), broken, tool("c2", 7)]);
    expect(times.has("x")).toBe(false);
    expect(times.get("c2")?.tookMs).toBe(5_000);
  });

  it("times history once per array and continues the live rows from its end", () => {
    const history = [user("u", 0), tool("c", 3)];
    const first = timeHistory(history);
    expect(timeHistory(history)).toBe(first);
    const live = new Map<string, ItemTime>();
    timeItems([assistant("a", 8, "m1")], first.end, live);
    expect(live.get("a")?.tookMs).toBe(5_000);
  });

  it("times a grouped run from before its first call to the end of its last", () => {
    const times = timesOf([user("u", 0), tool("c1", 2), tool("c2", 5), tool("c3", 11)]);
    const group = groupItemTime([tool("c1", 2), tool("c2", 5), tool("c3", 11)], (id) =>
      times.get(id),
    );
    expect(group).toEqual({ at: at(11), tookMs: 11_000 });
  });

  it("shows one time per message, under its last piece", () => {
    expect(continuesAssistantMessage(assistant("a1", 1, "m1"), assistant("a2", 2, "m1"))).toBe(
      true,
    );
    expect(continuesAssistantMessage(assistant("a1", 1, "m1"), tool("c", 2))).toBe(false);
    expect(continuesAssistantMessage(assistant("a1", 1), assistant("a2", 2))).toBe(false);
  });

  it("follows the master switch and each type's switch", () => {
    expect(itemTimeKind(tool("c", 0))).toBe("toolCalls");
    expect(showsItemTime(DEFAULT_ITEM_TIMES_PREFERENCES, "toolCalls")).toBe(true);
    expect(showsItemTime(DEFAULT_ITEM_TIMES_PREFERENCES, "user")).toBe(false);
    expect(showsItemTime({ ...DEFAULT_ITEM_TIMES_PREFERENCES, enabled: false }, "assistant")).toBe(
      false,
    );
  });
});

describe("resolveItemTimeSideWidth", () => {
  const pane = (paneWidth: number) =>
    resolveItemTimeSideWidth({
      paneWidth,
      contentMaxWidth: 820,
      listPaddingHorizontal: 16,
      columnPaddingHorizontal: 8,
    });

  it("uses the margin once it holds the narrowest label beside the rail", () => {
    expect(pane(1261)).toBeNull();
    expect(pane(1262)).toBe(144);
  });

  it("steps the width so small resizes keep the same value", () => {
    expect(pane(1293)).toBe(144);
    expect(pane(1294)).toBe(160);
    expect(pane(1295)).toBe(160);
    expect(pane(1326)).toBe(176);
  });

  it("caps the width on very wide panes", () => {
    expect(pane(1600)).toBe(240);
    expect(pane(3000)).toBe(240);
  });

  it("keeps the line under the row when the column fills the pane", () => {
    expect(pane(600)).toBeNull();
    expect(pane(0)).toBeNull();
  });

  it("keeps the line under the row for the uncapped Full width preset", () => {
    expect(
      resolveItemTimeSideWidth({
        paneWidth: 1600,
        contentMaxWidth: undefined,
        listPaddingHorizontal: 16,
        columnPaddingHorizontal: 8,
        outlineInset: 44,
      }),
    ).toBeNull();
  });

  it("accounts for the Wide preset and chat outline rail inset", () => {
    expect(
      resolveItemTimeSideWidth({
        paneWidth: 1262,
        contentMaxWidth: 820,
        listPaddingHorizontal: 16,
        columnPaddingHorizontal: 8,
        outlineInset: 44,
      }),
    ).toBe(144);
    expect(
      resolveItemTimeSideWidth({
        paneWidth: 1641,
        contentMaxWidth: 1200,
        listPaddingHorizontal: 16,
        columnPaddingHorizontal: 8,
        outlineInset: 44,
      }),
    ).toBeNull();
    expect(
      resolveItemTimeSideWidth({
        paneWidth: 1642,
        contentMaxWidth: 1200,
        listPaddingHorizontal: 16,
        columnPaddingHorizontal: 8,
        outlineInset: 44,
      }),
    ).toBe(144);
  });
});
