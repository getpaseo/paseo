import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "../opencode-agent.js";
import { revertOpenCodeConversationAndFiles, type OpenCodeRewindClient } from "./rewind.js";

function rewindCapabilities(capabilities: OpenCodeAgentClient["capabilities"]) {
  return {
    supportsRewindConversation: capabilities.supportsRewindConversation,
    supportsRewindFiles: capabilities.supportsRewindFiles,
    supportsRewindBoth: capabilities.supportsRewindBoth,
  };
}

class FakeOpencodeClient implements OpenCodeRewindClient {
  readonly recordedReverts: Array<{ sessionID: string; directory: string; messageID: string }> = [];
  revertResponse: Awaited<ReturnType<OpenCodeRewindClient["session"]["revert"]>> = {};

  readonly session = {
    revert: async (input: { sessionID: string; directory: string; messageID: string }) => {
      this.recordedReverts.push(input);
      return this.revertResponse;
    },
  };
}

describe("OpenCode rewind", () => {
  test("rewinds conversation and files to the OpenCode user message", async () => {
    const opencode = new FakeOpencodeClient();

    await revertOpenCodeConversationAndFiles({
      client: opencode,
      sessionId: "session-1",
      cwd: "/workspace/project",
      messageId: "user-message-1",
    });

    expect(opencode.recordedReverts).toEqual([
      { sessionID: "session-1", directory: "/workspace/project", messageID: "user-message-1" },
    ]);
  });

  test("surfaces OpenCode revert errors", async () => {
    const opencode = new FakeOpencodeClient();
    opencode.revertResponse = { error: { name: "NotFoundError", message: "missing message" } };

    await expect(
      revertOpenCodeConversationAndFiles({
        client: opencode,
        sessionId: "session-1",
        cwd: "/workspace/project",
        messageId: "missing-message",
      }),
    ).rejects.toThrow("missing message");
    expect(opencode.recordedReverts).toEqual([
      { sessionID: "session-1", directory: "/workspace/project", messageID: "missing-message" },
    ]);
  });

  test("declares only combined rewind capability", () => {
    const client = new OpenCodeAgentClient(createTestLogger());

    expect(rewindCapabilities(client.capabilities)).toEqual({
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: true,
    });
  });
});
