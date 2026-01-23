import { describe, expect, test } from "vitest";

import { serializeAgentStreamEvent } from "./messages.js";

describe("serializeAgentStreamEvent", () => {
  test("strips leading paseo-instructions from user_message timeline items", () => {
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
    expect(serialized.item.text).toBe("Hello");
    expect(serialized.item.messageId).toBe("m1");
  });

  test("does not strip non-leading tags", () => {
    const event = {
      type: "timeline",
      provider: "claude",
      item: {
        type: "user_message",
        text: "Hello <paseo-instructions>\nX\n</paseo-instructions>",
      },
    } as any;

    const serialized = serializeAgentStreamEvent(event) as any;
    expect(serialized.item.text).toBe(event.item.text);
  });
});

