import { describe, expect, test } from "vitest";

import { serializeAgentStreamEvent } from "./messages.js";

describe("serializeAgentStreamEvent", () => {
  test("preserves user_message text as-is", () => {
    const event = {
      type: "timeline",
      provider: "claude",
      item: {
        type: "user_message",
        text: "<paseo-instructions>\nX\n</paseo-instructions>\n\nHello",
        messageId: "m1",
      },
    } as any;

    const serialized = serializeAgentStreamEvent(event) as any;
    expect(serialized.item.text).toBe(event.item.text);
    expect(serialized.item.messageId).toBe("m1");
  });
});
