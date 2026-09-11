import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { hydrateStreamState, isAgentToolCallItem, reduceStreamUpdate } from "@/types/stream";
import { readToolCallSummary } from "@getpaseo/protocol/tool-call-summary";

const call = {
  type: "timeline",
  provider: "codex",
  turnId: "turn-1",
  item: {
    type: "tool_call",
    callId: "call-1",
    name: "shell",
    status: "completed",
    error: null,
    detail: { type: "shell", command: "npm test", output: "Passed" },
  },
} satisfies AgentStreamEventPayload;
const description = "Ran the tests successfully.";
const update: AgentStreamEventPayload = {
  ...call,
  item: { ...call.item, metadata: { "paseo.toolCallSummary": { description } } },
};

describe("summary timeline updates", () => {
  it("clears a stale description when the provider changes its terminal output", () => {
    const initial = reduceStreamUpdate([], update, new Date(1));
    const changed = reduceStreamUpdate(
      initial,
      {
        ...call,
        item: {
          ...call.item,
          detail: { ...call.item.detail, output: "Different result" },
          metadata: { "paseo.toolCallSummary": null },
        },
      },
      new Date(2),
    );
    const tool = changed.find(isAgentToolCallItem);
    expect(changed).toHaveLength(1);
    expect(readToolCallSummary(tool?.payload.data.metadata)).toBeUndefined();
    expect(tool?.payload.data.detail).toMatchObject({ output: "Different result" });
  });

  it("updates the existing row in place even after the assistant has spoken", () => {
    const initial = reduceStreamUpdate([], call, new Date(1));
    const withMessage = reduceStreamUpdate(
      initial,
      { type: "timeline", provider: "codex", item: { type: "assistant_message", text: "Done." } },
      new Date(2),
    );
    const updated = reduceStreamUpdate(withMessage, update, new Date(1));
    expect(updated.map((item) => item.kind)).toEqual(["tool_call", "assistant_message"]);
    const tool = updated.find(isAgentToolCallItem);
    expect(tool?.payload.data.detail).toEqual(call.item.detail);
    expect(readToolCallSummary(tool?.payload.data.metadata)).toBe(description);
  });
  it("hydrates and replays an annotated call without duplicating it or losing its raw details", () => {
    const restored = hydrateStreamState([{ event: update, timestamp: new Date(1) }]);
    const replayed = reduceStreamUpdate(restored, update, new Date(1));
    expect(replayed).toHaveLength(1);
    const tool = replayed.find(isAgentToolCallItem);
    expect(readToolCallSummary(tool?.payload.data.metadata)).toBe(description);
    expect(tool?.payload.data.detail).toEqual(call.item.detail);
  });
});
