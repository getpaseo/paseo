import { describe, expect, test } from "vitest";
import { captureModelSwitchAnchor, restoreModelSwitches } from "./model-switch-history.js";
import type { AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";

const message = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });
const event = (item: AgentTimelineItem): Extract<AgentStreamEvent, { type: "timeline" }> => ({
  type: "timeline",
  provider: "codex",
  item,
});

describe("model switch history", () => {
  test("restores switches after their uniquely matched preceding message", () => {
    const anchor = captureModelSwitchAnchor([message("First response")]);
    const records = [
      { model: "a", timestamp: "2026-11-18T00:00:00.000Z", anchor },
      { model: "b", timestamp: "2026-11-18T00:00:01.000Z", anchor },
    ];
    expect(
      restoreModelSwitches(
        [
          event(message("First response")),
          event({ type: "user_message", text: "Next" }),
          event(message("Later response")),
        ],
        records,
        "codex",
      ).map((entry) => entry.item),
    ).toEqual([
      message("First response"),
      {
        type: "notification",
        level: "info",
        message: "Switched to a",
        modelChange: { model: "a" },
      },
      {
        type: "notification",
        level: "info",
        message: "Switched to b",
        modelChange: { model: "b" },
      },
      { type: "user_message", text: "Next" },
      message("Later response"),
    ]);
  });

  test("matches a complete message against fragmented provider replay", () => {
    const record = {
      model: "a",
      timestamp: "2026-11-18T00:00:00.000Z",
      anchor: captureModelSwitchAnchor([message("hello world")]),
    };
    expect(
      restoreModelSwitches(
        [event(message("hello ")), event(message("world"))],
        [record],
        "codex",
      ).map((entry) => entry.item),
    ).toEqual([
      message("hello "),
      message("world"),
      {
        type: "notification",
        level: "info",
        message: "Switched to a",
        modelChange: { model: "a" },
      },
    ]);
  });

  test("keeps unanchored and ambiguous switches out of replay", () => {
    const anchor = captureModelSwitchAnchor([message("repeat")]);
    const record = { model: "a", timestamp: "2026-11-18T00:00:00.000Z", anchor };
    expect(restoreModelSwitches([event(message("different"))], [record], "codex")).toEqual([
      event(message("different")),
    ]);
    expect(
      restoreModelSwitches(
        [
          event(message("repeat")),
          event({ type: "user_message", text: "Next" }),
          event(message("repeat")),
        ],
        [record],
        "codex",
      ),
    ).toEqual([
      event(message("repeat")),
      event({ type: "user_message", text: "Next" }),
      event(message("repeat")),
    ]);
  });

  test("restores switches made before the first timeline item at the start", () => {
    const record = {
      model: null,
      timestamp: "2026-11-18T00:00:00.000Z",
      anchor: captureModelSwitchAnchor([]),
    };
    expect(
      restoreModelSwitches([event(message("Later"))], [record], "codex").map((entry) => entry.item),
    ).toEqual([
      {
        type: "notification",
        level: "info",
        message: "Switched to the default model",
        modelChange: { model: null },
      },
      message("Later"),
    ]);
  });
});
