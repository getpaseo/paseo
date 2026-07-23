import { describe, expect, it } from "vitest";
import {
  buildChatWorkspaceCreateAgentOptions,
  isEmptyChatWorkspaceSubmission,
} from "./chat-workspace";

describe("buildChatWorkspaceCreateAgentOptions", () => {
  it("creates a chat workspace agent without an existing workspace", () => {
    expect(
      buildChatWorkspaceCreateAgentOptions({
        provider: "codex",
        composerState: {
          selectedMode: "plan",
          effectiveModelId: "gpt-5",
          effectiveThinkingOptionId: "high",
          featureValues: { fastMode: true },
        },
        text: "  Help me think this through  ",
        clientMessageId: "message-1",
        images: undefined,
        attachments: [],
      }),
    ).toEqual({
      config: {
        provider: "codex",
        cwd: "",
        modeId: "plan",
        model: "gpt-5",
        thinkingOptionId: "high",
        featureValues: { fastMode: true },
      },
      chatWorkspace: true,
      initialPrompt: "Help me think this through",
      clientMessageId: "message-1",
    });
  });
});

describe("isEmptyChatWorkspaceSubmission", () => {
  it("requires non-empty prompt text", () => {
    expect(isEmptyChatWorkspaceSubmission(" \n\t ")).toBe(true);
    expect(isEmptyChatWorkspaceSubmission("Hello")).toBe(false);
  });
});
