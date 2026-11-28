import { describe, expect, it } from "vitest";
import { normalizeTimelineReplay } from "./normalize-timeline-replay";
import type { StreamItem } from "@/types/stream";

const epoch = "fixture-epoch";
const item = (
  kind: "user_message" | "assistant_message",
  id: string,
  seq: number,
  text = "SAME_TEXT",
): StreamItem =>
  ({ kind, id, messageId: id, text, timestamp: new Date(1), timelineCursor: { epoch, seq } }) as StreamItem;

describe("normalizeTimelineReplay", () => {
  it("repairs only exact cached assistant repeats without mutating native or owner history", () => {
    const a = item("assistant_message", "a", 1);
    const b = item("assistant_message", "b", 2);
    const u = item("user_message", "u", 3);
    const value = { agentId: "fixture", items: [a, a, b, u, u], range: null, hasOlder: false };
    const fixed = normalizeTimelineReplay(value)!;
    expect(fixed.items).toHaveLength(4);
    expect(value.items).toHaveLength(5);
    expect(fixed.items.filter((x) => x.kind === "user_message")).toHaveLength(2);
    expect(normalizeTimelineReplay(fixed)).toBe(fixed);
  });

  it("keeps distinct same-text sources and prefix extensions across repeated hydration", () => {
    const base = [
      item("user_message", "u1", 1),
      item("assistant_message", "a1", 2),
      item("assistant_message", "a2", 3),
    ];
    let hydrated = [...base, item("assistant_message", "a5", 7, "PREFIX")];
    for (let cycle = 0; cycle < 4; cycle++) {
      const next = normalizeTimelineReplay({
        agentId: "fixture",
        items: [...hydrated, item("assistant_message", "a5", 8, "PREFIX longer")],
        range: null,
        hasOlder: false,
      })!;
      expect(next.items.filter((x) => x.kind === "assistant_message")).toHaveLength(4);
      hydrated = next.items;
    }
    expect(hydrated.at(-1)?.text).toBe("PREFIX longer");
  });

  it("returns the same value untouched when nothing repeats", () => {
    const value = { agentId: "fixture", items: [item("user_message", "u", 1)], range: null, hasOlder: false };
    expect(normalizeTimelineReplay(value)).toBe(value);
    expect(normalizeTimelineReplay(undefined)).toBeUndefined();
  });
});
