import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { OpenCodeV2AgentClient } from "../opencode-v2-agent.js";
import {
  TestOpenCodeV2Client,
  TestOpenCodeV2Harness,
} from "./test-utils/test-opencode-v2-harness.js";

const TEST_MODEL = "baseten/deepseek-ai/DeepSeek-V4-Flash-0731";

async function createRewindSession(configure?: (client: TestOpenCodeV2Client) => void): Promise<{
  readonly session: Awaited<ReturnType<OpenCodeV2AgentClient["createSession"]>>;
  readonly openCode: TestOpenCodeV2Client;
}> {
  const runtime = new TestOpenCodeV2Harness();
  const openCode = new TestOpenCodeV2Client();
  configure?.(openCode);
  runtime.enqueueClient(openCode);
  const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const session = await client.createSession({
    provider: "opencode-v2",
    cwd: "/workspace/repo",
    model: TEST_MODEL,
  });
  return { session, openCode };
}

function rewindCapabilities(capabilities: OpenCodeV2AgentClient["capabilities"]) {
  return {
    supportsRewindConversation: capabilities.supportsRewindConversation,
    supportsRewindFiles: capabilities.supportsRewindFiles,
    supportsRewindBoth: capabilities.supportsRewindBoth,
  };
}

describe("OpenCodeV2AgentSession rewind", () => {
  test("revertBoth stages then commits a rewind to the target message", async () => {
    const { session, openCode } = await createRewindSession();

    await session.revertBoth({ messageId: "msg_user_1" });

    expect(openCode.calls.sessionRevertStage).toEqual([
      { sessionID: "session-1", messageID: "msg_user_1" },
    ]);
    expect(openCode.calls.sessionRevertCommit).toEqual([{ sessionID: "session-1" }]);
    expect(openCode.calls.sessionRevertClear).toEqual([]);
  });

  test("revertBoth surfaces a stage error cleanly (no commit attempted)", async () => {
    const { session, openCode } = await createRewindSession((client) => {
      client.sessionRevertStageError = new Error("Message not found: msg_missing");
    });

    await expect(session.revertBoth({ messageId: "msg_missing" })).rejects.toThrow(
      "Message not found: msg_missing",
    );
    expect(openCode.calls.sessionRevertStage).toEqual([
      { sessionID: "session-1", messageID: "msg_missing" },
    ]);
    expect(openCode.calls.sessionRevertCommit).toEqual([]);
  });

  test("revertBoth surfaces a commit error cleanly after a successful stage", async () => {
    const { session, openCode } = await createRewindSession((client) => {
      client.sessionRevertCommitError = new Error("Session is busy");
    });

    await expect(session.revertBoth({ messageId: "msg_user_1" })).rejects.toThrow(
      "Session is busy",
    );
    expect(openCode.calls.sessionRevertStage).toEqual([
      { sessionID: "session-1", messageID: "msg_user_1" },
    ]);
    expect(openCode.calls.sessionRevertCommit).toEqual([{ sessionID: "session-1" }]);
  });

  test("revertClear clears a staged rewind without committing", async () => {
    const { session, openCode } = await createRewindSession();

    await session.revertClear();

    expect(openCode.calls.sessionRevertClear).toEqual([{ sessionID: "session-1" }]);
    expect(openCode.calls.sessionRevertStage).toEqual([]);
    expect(openCode.calls.sessionRevertCommit).toEqual([]);
  });

  test("revertClear surfaces a clear error cleanly", async () => {
    const { session, openCode } = await createRewindSession((client) => {
      client.sessionRevertClearError = new Error("Session not found");
    });

    await expect(session.revertClear()).rejects.toThrow("Session not found");
    expect(openCode.calls.sessionRevertClear).toEqual([{ sessionID: "session-1" }]);
  });

  test("declares only the combined rewind capability", async () => {
    const { session } = await createRewindSession();

    expect(rewindCapabilities(session.capabilities)).toEqual({
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: true,
    });
  });
});
