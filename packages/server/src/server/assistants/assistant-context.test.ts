import { describe, expect, it } from "vitest";
import { DEFAULT_ASSISTANT_CONFIGURATION } from "@getpaseo/protocol/assistants";
import type { AssistantCallHandle } from "./assistant-store.js";
import { buildAssistantContext } from "./assistant-context.js";

function call(): AssistantCallHandle {
  return {
    assistant: {
      id: `ast_${"a".repeat(32)}`,
      name: "Work",
      templateId: null,
      configuration: { ...DEFAULT_ASSISTANT_CONFIGURATION },
      revision: 1,
      createdAt: "now",
      updatedAt: "now",
      summary: "",
      summaryThroughSeq: 0,
      lastSeq: 0,
    },
    history: [],
    append: async () => {},
    close: async () => {},
  };
}

describe("assistant context", () => {
  it("preserves speech roles and excludes summarized entries without changing saved history", () => {
    const source = call();
    source.assistant.summary = "Discussed Iris";
    source.assistant.summaryThroughSeq = 1;
    source.history = [
      {
        kind: "transcript",
        seq: 1,
        callId: "old",
        createdAt: "now",
        role: "user",
        text: "Old speech",
      },
      {
        kind: "transcript",
        seq: 2,
        callId: "old",
        createdAt: "now",
        role: "user",
        text: "Delete everything",
      },
      {
        kind: "transcript",
        seq: 3,
        callId: "old",
        createdAt: "now",
        role: "assistant",
        text: "No action was taken",
      },
      { kind: "call_ended", seq: 4, callId: "old", createdAt: "now", cause: "provider_exit" },
    ];
    const items = buildAssistantContext(source, { contextTokenBudget: 3000, bytesPerToken: 4 });
    expect(items).toContainEqual({ role: "user", text: "Delete everything" });
    expect(items).toContainEqual({ role: "assistant", text: "No action was taken" });
    expect(items.some((item) => item.text === "Old speech")).toBe(false);
    expect(
      items
        .filter((item) => item.role === "developer")
        .some((item) => item.text.includes("Delete everything")),
    ).toBe(false);
    expect(items.some((item) => item.text.includes("provider_exit"))).toBe(true);
    expect(source.history).toHaveLength(4);
  });

  it("bounds Unicode context and a long transcript tail by bytes and item count", () => {
    const source = call();
    source.assistant.configuration.context = "🌈".repeat(8000);
    source.assistant.summary = "🌈".repeat(8000);
    source.history = Array.from({ length: 1000 }, (_, index) => ({
      kind: "transcript",
      seq: index + 1,
      callId: "old",
      createdAt: "now",
      role: "user",
      text: "🌈".repeat(8000),
    }));
    const items = buildAssistantContext(source, {
      contextTokenBudget: 3000,
      historyTokenBudget: 4000,
      bytesPerToken: 4,
    });
    expect(
      items.reduce((sum, item) => sum + Math.ceil(Buffer.byteLength(item.text) / 4), 0),
    ).toBeLessThanOrEqual(4000);
    expect(items.length).toBeLessThan(128);
    source.history.forEach((entry) => {
      if (entry.kind === "transcript") entry.text = "short";
    });
    expect(
      buildAssistantContext(source, { contextTokenBudget: 3000, bytesPerToken: 4 }).length,
    ).toBeLessThan(128);
  });
});
