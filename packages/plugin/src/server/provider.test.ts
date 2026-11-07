import { describe, expect, it } from "vitest";

import { ProviderEventSchema } from "./provider.js";

describe("ProviderEventSchema", () => {
  it("keeps the prompt a plugin provider puts on a sub_agent card", () => {
    const prompt = "Map the repository layout.\n\nList the top-level folders.";
    const parsed = ProviderEventSchema.parse({
      type: "timeline.item",
      sessionId: "session-1",
      item: {
        type: "tool_call",
        id: "task-1",
        callId: "task-1",
        name: "Task",
        status: "running",
        error: null,
        detail: { type: "sub_agent", subAgentType: "Explore", prompt, log: "" },
      },
    });

    expect(parsed).toMatchObject({ item: { detail: { type: "sub_agent", prompt } } });
  });
});
