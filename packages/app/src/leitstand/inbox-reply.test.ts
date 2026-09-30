import { describe, expect, it } from "vitest";
import { lastAssistantText } from "./inbox-reply";

function entry(item: Record<string, unknown>) {
  return {
    provider: "claude",
    item,
    timestamp: "2026-09-30T10:00:00.000Z",
    seqStart: 0,
    seqEnd: 0,
    sourceSeqRanges: [],
    collapsed: [],
  } as never;
}

describe("lastAssistantText", () => {
  it("takes the newest assistant message and flattens it to one line", () => {
    const text = lastAssistantText([
      entry({ type: "assistant_message", text: "old answer" }),
      entry({ type: "assistant_message", text: "Ausgerollt:\n\n- Daemon  läuft" }),
      entry({ type: "user_message", text: "danke" }),
    ]);
    expect(text).toBe("Ausgerollt: - Daemon läuft");
  });

  it("cuts long replies and returns null without assistant text", () => {
    expect(
      lastAssistantText([entry({ type: "assistant_message", text: "x".repeat(400) })]),
    ).toHaveLength(281);
    expect(lastAssistantText([entry({ type: "user_message", text: "hi" })])).toBeNull();
  });
});
