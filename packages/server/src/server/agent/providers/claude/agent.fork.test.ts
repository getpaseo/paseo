import { describe, expect, test } from "vitest";
import pino from "pino";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeRewindSdk } from "./rewind.js";
import type {
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from "../../agent-sdk-types.js";

const logger = pino({ level: "silent" });

/** Records fork calls and returns a configurable forked session id. */
class RecordingRewindSdk implements ClaudeRewindSdk {
  readonly forkCalls: Array<{ sessionId: string; upToMessageId: string }> = [];
  private nextSessionId: string;

  constructor(nextSessionId = "forked-session") {
    this.nextSessionId = nextSessionId;
  }

  async forkSession(
    sessionId: string,
    options: { upToMessageId: string },
  ): Promise<{ sessionId: string }> {
    this.forkCalls.push({ sessionId, upToMessageId: options.upToMessageId });
    return { sessionId: this.nextSessionId };
  }
}

/** Overrides resumeSession so forkSession can be exercised without a process. */
class TestClaudeAgentClient extends ClaudeAgentClient {
  readonly resumeCalls: Array<{
    handle: AgentPersistenceHandle;
    overrides?: Partial<AgentSessionConfig>;
    launchContext?: AgentLaunchContext;
  }> = [];

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.resumeCalls.push({ handle, overrides, launchContext });
    return { id: "mock-session" } as AgentSession;
  }
}

interface Harness {
  client: TestClaudeAgentClient;
  rewindSdk: RecordingRewindSdk;
}

function createHarness(options?: {
  nextSessionId?: string;
  readSessionFile?: (filePath: string) => Promise<string>;
}): Harness {
  const rewindSdk = new RecordingRewindSdk(options?.nextSessionId ?? "forked-session");
  const client = new TestClaudeAgentClient({
    logger,
    resolveBinary: async () => "/usr/local/bin/claude",
    rewindSdk,
    readSessionFile: options?.readSessionFile,
  });
  return { client, rewindSdk };
}

describe("ClaudeAgentClient.forkSession", () => {
  test("capabilities.supportsFork is true", () => {
    const { client } = createHarness();
    expect(client.capabilities.supportsFork).toBe(true);
  });

  test("forkSession uses provided upToMessageId and calls the rewind sdk", async () => {
    const { client, rewindSdk } = createHarness({ nextSessionId: "new-forked-session" });

    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "original-session-id",
      nativeHandle: "original-session-id",
      metadata: { cwd: "/tmp/test-project" },
    };

    await client.forkSession(handle, { upToMessageId: "msg-uuid-123" });

    expect(rewindSdk.forkCalls).toEqual([
      { sessionId: "original-session-id", upToMessageId: "msg-uuid-123" },
    ]);
    expect(client.resumeCalls).toEqual([
      {
        handle: {
          ...handle,
          sessionId: "new-forked-session",
          nativeHandle: "new-forked-session",
        },
        overrides: undefined,
        launchContext: undefined,
      },
    ]);
  });

  test("forkSession resolves last message id from JSONL when upToMessageId is omitted", async () => {
    const sessionContent = [
      JSON.stringify({ type: "system", uuid: "sys-1", content: "system prompt" }),
      JSON.stringify({ type: "user", uuid: "user-msg-1", content: [{ type: "text", text: "hi" }] }),
      JSON.stringify({
        type: "assistant",
        uuid: "asst-msg-1",
        content: [{ type: "text", text: "hello" }],
      }),
      JSON.stringify({
        type: "user",
        uuid: "user-msg-2",
        content: [{ type: "text", text: "bye" }],
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "asst-msg-2",
        content: [{ type: "text", text: "goodbye" }],
      }),
    ].join("\n");

    const { client, rewindSdk } = createHarness({
      nextSessionId: "forked-from-last",
      readSessionFile: async () => sessionContent,
    });

    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "session-for-whole-fork",
      nativeHandle: "session-for-whole-fork",
      metadata: { cwd: "/tmp/test-project" },
    };

    await client.forkSession(handle, {});

    // Should resolve the last user or assistant message uuid.
    expect(rewindSdk.forkCalls).toEqual([
      { sessionId: "session-for-whole-fork", upToMessageId: "asst-msg-2" },
    ]);
    expect(client.resumeCalls[0]?.handle).toMatchObject({
      sessionId: "forked-from-last",
      nativeHandle: "forked-from-last",
    });
  });

  test("forkSession throws when session file cannot be read and no upToMessageId", async () => {
    const { client } = createHarness({
      readSessionFile: async () => {
        throw new Error("ENOENT");
      },
    });

    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "missing-session",
      nativeHandle: "missing-session",
      metadata: { cwd: "/tmp/nonexistent" },
    };

    await expect(client.forkSession(handle, {})).rejects.toThrow(/session file not found/);
  });

  test("forkSession throws when no cwd in metadata and no upToMessageId", async () => {
    const { client } = createHarness();

    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "no-cwd-session",
      nativeHandle: "no-cwd-session",
      metadata: {},
    };

    await expect(client.forkSession(handle, {})).rejects.toThrow(/working directory.*not found/);
  });

  test("forkSession does not mutate the original handle", async () => {
    const { client } = createHarness({ nextSessionId: "brand-new-id" });

    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "keep-me-intact",
      nativeHandle: "keep-me-intact",
      metadata: { cwd: "/tmp/test" },
    };

    await client.forkSession(handle, { upToMessageId: "some-msg" });

    expect(handle.sessionId).toBe("keep-me-intact");
    expect(handle.nativeHandle).toBe("keep-me-intact");
  });
});
