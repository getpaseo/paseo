import { describe, expect, it } from "vitest";
import { ProviderEventSchema, ProviderInputSchema, type ProviderInput } from "./provider.js";

type ReviewMode = "uncommitted" | "base" | "all";
type Delivery = "auto" | "steer";

const contextLine = {
  oldLineNumber: null,
  newLineNumber: 12,
  type: "add",
  content: "const value = 1;",
} as const;

function reviewPrompt(mode: ReviewMode, delivery: Delivery): ProviderInput {
  return {
    type: "session.prompt",
    sessionId: "session-1",
    prompt: {
      clientMessageId: "message-1",
      delivery,
      input: {
        type: "message",
        content: [
          {
            type: "review",
            mimeType: "application/paseo-review",
            cwd: "/workspace",
            mode,
            baseRef: "main",
            comments: [
              {
                filePath: "src/index.ts",
                side: "new",
                lineNumber: 12,
                body: "Please review this change.",
                context: {
                  hunkHeader: "@@ -10,2 +10,3 @@",
                  targetLine: contextLine,
                  lines: [{ ...contextLine, type: "context", oldLineNumber: 11 }, contextLine],
                },
              },
            ],
          },
        ],
      },
    },
  };
}

describe("Provider review attachments", () => {
  it.each(["uncommitted", "base", "all"] as const)(
    "preserves mode %s on an ordinary prompt",
    (mode) => {
      const input = reviewPrompt(mode, "auto");
      expect(ProviderInputSchema.parse(input)).toEqual(input);
    },
  );

  it.each(["uncommitted", "base", "all"] as const)(
    "preserves mode %s on a steering prompt",
    (mode) => {
      const input = reviewPrompt(mode, "steer");
      expect(ProviderInputSchema.parse(input)).toEqual(input);
    },
  );
});

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
