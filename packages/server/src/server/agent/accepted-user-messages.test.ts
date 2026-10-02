import { expect, test } from "vitest";
import { restoreAcceptedUserMessages } from "./accepted-user-messages.js";
import type { AcceptedUserMessage } from "./agent-storage.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";

const accepted: AcceptedUserMessage = {
  timestamp: "2026-10-03T12:00:00.000Z",
  providerMessageId: "provider-1",
  item: {
    type: "user_message",
    text: "Same text",
    clientMessageId: "client-1",
    messageId: "client-1",
    prompt: [{ type: "image", data: "image-data", mimeType: "image/png" }],
  },
};

function replay(messageId: string): Extract<AgentStreamEvent, { type: "timeline" }> {
  return {
    type: "timeline",
    provider: "mock",
    item: { type: "user_message", text: "Same text", messageId },
  };
}

test("reload enriches exact provider identity, never a repeated text, and rewind removes unmatched accepted rows", () => {
  const restored = restoreAcceptedUserMessages(
    [replay("other"), replay("provider-1")],
    [accepted],
    "mock",
    true,
  );
  expect(restored.events.map((event) => event.item)).toEqual([
    replay("other").item,
    { ...accepted.item, messageId: "provider-1" },
  ]);
  expect(restored.retainedIds).toEqual(new Set(["client-1"]));
  const unmatched = restoreAcceptedUserMessages([replay("other")], [accepted], "mock", true);
  expect(unmatched.events).toHaveLength(2);
  expect(unmatched.events[1]?.item).toEqual(accepted.item);
  const rewound = restoreAcceptedUserMessages([replay("other")], [accepted], "mock", false);
  expect(rewound.events).toEqual([replay("other")]);
  expect(rewound.retainedIds.size).toBe(0);
});
