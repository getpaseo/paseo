import { expect, it } from "vitest";
import { selectResponseContext } from "./response-context.js";
import type { AgentTimelineRow } from "./agent/agent-timeline-store-types.js";
it("selects an entire historical response on the host independently of the client's page", () => {
  const rows: AgentTimelineRow[] = [
    { seq: 1, timestamp: "", item: { type: "user_message", text: "Compare" } },
    {
      seq: 2,
      timestamp: "",
      item: { type: "assistant_message", messageId: "first", text: "Assumptions" },
    },
    {
      seq: 3,
      timestamp: "",
      item: {
        type: "tool_call",
        callId: "ui",
        name: "mcp__paseo__render_interactive_response",
        status: "completed",
        error: null,
        detail: {
          type: "unknown",
          input: {},
          output: JSON.stringify({ structuredContent: { documentId: "doc" } }),
        },
      },
    },
    {
      seq: 4,
      timestamp: "",
      item: { type: "assistant_message", messageId: "last", text: "Recommendation" },
    },
    { seq: 5, timestamp: "", item: { type: "user_message", text: "Next" } },
    { seq: 6, timestamp: "", item: { type: "assistant_message", text: "Another response" } },
  ];
  expect(selectResponseContext(rows, { cursor: { seq: 4 } })).toEqual({
    text: "Assumptions\n\nRecommendation",
    documentIds: ["doc"],
  });
  expect(selectResponseContext(rows, { messageId: "first" })).toEqual({
    text: "Assumptions\n\nRecommendation",
    documentIds: ["doc"],
  });
  expect(selectResponseContext(rows, { messageId: "first", cursor: { seq: 99 } })).toEqual({
    text: "Assumptions\n\nRecommendation",
    documentIds: ["doc"],
  });
  expect(() => selectResponseContext(rows, { cursor: { seq: 5 } })).toThrow();
});
