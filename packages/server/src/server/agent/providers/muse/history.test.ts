import { describe, expect, test, vi } from "vitest";

import {
  extractMuseHistoryItems,
  mapMuseHistoryItem,
  pageMuseHistoryEvents,
} from "./history.js";
import type { MuseViewItem } from "./items.js";

function item(overrides: Partial<MuseViewItem> = {}): MuseViewItem {
  return {
    itemId: "item-1",
    revision: 1,
    kind: "agentMessage",
    turnId: "turn-1",
    status: "completed",
    text: "hello",
    ...overrides,
  };
}

describe("extractMuseHistoryItems", () => {
  test("reads inline items and skips malformed rows", () => {
    const items = extractMuseHistoryItems({
      mode: "inline",
      items: [item(), { nope: true }, item({ itemId: "item-2" })],
    });

    expect(items?.map((entry) => entry.itemId)).toEqual(["item-1", "item-2"]);
  });

  test("reads snapshot state items", () => {
    for (const mode of ["snapshot", "anchoredSnapshot"]) {
      const items = extractMuseHistoryItems({
        mode,
        items: null,
        snapshot: { state: { items: [item()] } },
      });
      expect(items?.map((entry) => entry.itemId)).toEqual(["item-1"]);
    }
  });

  test("returns null when the caller must page", () => {
    expect(extractMuseHistoryItems({ mode: "none" })).toBeNull();
    expect(extractMuseHistoryItems({ mode: "future-mode" })).toBeNull();
    expect(extractMuseHistoryItems(null)).toBeNull();
    expect(extractMuseHistoryItems({ mode: "snapshot" })).toEqual([]);
  });
});

describe("mapMuseHistoryItem", () => {
  test("maps every supported kind without client ids", () => {
    expect(
      mapMuseHistoryItem(
        item({ kind: "userMessage", text: "hi", displayText: "hi!" }),
        "muse",
      ),
    ).toMatchObject({
      type: "timeline",
      item: { type: "user_message", text: "hi!", messageId: "item-1" },
    });
    expect(mapMuseHistoryItem(item(), "muse")).toMatchObject({
      item: { type: "assistant_message", text: "hello", messageId: "item-1" },
    });
    expect(
      mapMuseHistoryItem(item({ kind: "reasoning", text: undefined, summary: ["a", "b"] }), "muse"),
    ).toMatchObject({ item: { type: "reasoning", text: "a\n\nb" } });
    expect(
      mapMuseHistoryItem(
        item({ kind: "toolCall", tool: "shell_exec", callId: "c1", text: undefined }),
        "muse",
      ),
    ).toMatchObject({ item: { type: "tool_call", callId: "c1", status: "completed" } });
    expect(
      mapMuseHistoryItem(item({ kind: "compaction", text: undefined }), "muse"),
    ).toMatchObject({ item: { type: "compaction", status: "completed" } });
    expect(
      mapMuseHistoryItem(item({ kind: "subagent", text: undefined }), "muse"),
    ).toBeNull();
    expect(
      mapMuseHistoryItem(item({ kind: "agentMessage", text: "" }), "muse"),
    ).toBeNull();
  });
});

describe("pageMuseHistoryEvents", () => {
  test("pages until the cursor ends and folds events", async () => {
    const command = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params["cursor"] === undefined) {
        return {
          events: [
            {
              method: "item/completed",
              params: {
                item: {
                  itemId: "a1",
                  revision: 1,
                  kind: "agentMessage",
                  turnId: "t1",
                  status: "completed",
                  text: "paged",
                },
              },
            },
          ],
          nextCursor: "cursor-1",
        };
      }
      return { events: [], nextCursor: null };
    });

    const events = await pageMuseHistoryEvents(
      { command: command as never },
      "session-1",
      "muse",
    );

    expect(command).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "muse",
        item: { type: "assistant_message", text: "paged", messageId: "a1" },
        turnId: "t1",
      },
    ]);
  });

  test("stops when the cursor repeats", async () => {
    const command = vi.fn(async () => ({ events: [], nextCursor: "same" }));

    await pageMuseHistoryEvents({ command: command as never }, "session-1", "muse");

    expect(command).toHaveBeenCalledTimes(2);
  });

  test("collects subagent track events from paged frames", async () => {
    const command = vi.fn(async () => ({
      events: [
        {
          method: "item/completed",
          params: {
            item: {
              itemId: "sub-1",
              revision: 1,
              kind: "subagent",
              turnId: "t1",
              status: "completed",
              role: "researcher",
              subagentId: "child-1",
              result: { summary: "Found it" },
            },
          },
        },
      ],
      nextCursor: null,
    }));

    const events = await pageMuseHistoryEvents(
      { command: command as never },
      "session-1",
      "muse",
    );

    expect(events.map((event) => event.type)).toEqual([
      "provider_subagent",
      "provider_subagent",
    ]);
    expect(events[0]).toMatchObject({
      event: { type: "upsert", id: "child-1", status: "completed" },
    });
    expect(events[1]).toMatchObject({
      event: { type: "timeline", id: "child-1", item: { text: "Found it" } },
    });
  });
});
