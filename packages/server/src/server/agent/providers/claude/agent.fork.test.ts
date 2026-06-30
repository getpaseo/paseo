import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ClaudeAgentClient } from "./agent.js";
import type { AgentPersistenceHandle } from "../../agent-sdk-types.js";

// Mock the rewind module to intercept realClaudeRewindSdk.forkSession
vi.mock("./rewind.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./rewind.js")>();
  return {
    ...original,
    realClaudeRewindSdk: {
      forkSession: vi.fn(),
    },
  };
});

import { realClaudeRewindSdk } from "./rewind.js";
import pino from "pino";

const logger = pino({ level: "silent" });

describe("ClaudeAgentClient.forkSession", () => {
  let client: ClaudeAgentClient;
  let resumeSessionSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ClaudeAgentClient({
      logger,
      resolveBinary: async () => "/usr/local/bin/claude",
    });
    // Spy on resumeSession to avoid actually launching a process
    resumeSessionSpy = vi.fn().mockResolvedValue({ id: "mock-session" });
    client.resumeSession = resumeSessionSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("capabilities.supportsFork is true", () => {
    expect(client.capabilities.supportsFork).toBe(true);
  });

  test("forkSession uses provided upToMessageId and calls sdk.forkSession", async () => {
    const mockForkSession = vi.mocked(realClaudeRewindSdk.forkSession);
    mockForkSession.mockResolvedValue({ sessionId: "new-forked-session" });

    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "original-session-id",
      nativeHandle: "original-session-id",
      metadata: { cwd: "/tmp/test-project" },
    };

    await client.forkSession(handle, { upToMessageId: "msg-uuid-123" });

    expect(mockForkSession).toHaveBeenCalledWith("original-session-id", {
      upToMessageId: "msg-uuid-123",
    });
    expect(resumeSessionSpy).toHaveBeenCalledWith(
      {
        ...handle,
        sessionId: "new-forked-session",
        nativeHandle: "new-forked-session",
      },
      undefined,
      undefined,
    );
  });

  test("forkSession resolves last message id from JSONL when upToMessageId is omitted", async () => {
    const mockForkSession = vi.mocked(realClaudeRewindSdk.forkSession);
    mockForkSession.mockResolvedValue({ sessionId: "forked-from-last" });

    // Mock readFile on the private resolveLastMessageId path
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

    // Use dynamic import to access promises from node:fs
    const fs = await import("node:fs");
    const readFileSpy = vi.spyOn(fs.promises, "readFile").mockResolvedValue(sessionContent);

    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "session-for-whole-fork",
      nativeHandle: "session-for-whole-fork",
      metadata: { cwd: "/tmp/test-project" },
    };

    await client.forkSession(handle, {});

    // Should resolve last assistant message uuid
    expect(mockForkSession).toHaveBeenCalledWith("session-for-whole-fork", {
      upToMessageId: "asst-msg-2",
    });
    expect(resumeSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "forked-from-last",
        nativeHandle: "forked-from-last",
      }),
      undefined,
      undefined,
    );

    readFileSpy.mockRestore();
  });

  test("forkSession throws when session file cannot be read and no upToMessageId", async () => {
    const fs = await import("node:fs");
    const readFileSpy = vi.spyOn(fs.promises, "readFile").mockRejectedValue(new Error("ENOENT"));

    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "missing-session",
      nativeHandle: "missing-session",
      metadata: { cwd: "/tmp/nonexistent" },
    };

    await expect(client.forkSession(handle, {})).rejects.toThrow(/session file not found/);

    readFileSpy.mockRestore();
  });

  test("forkSession throws when no cwd in metadata and no upToMessageId", async () => {
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "no-cwd-session",
      nativeHandle: "no-cwd-session",
      metadata: {},
    };

    await expect(client.forkSession(handle, {})).rejects.toThrow(/working directory.*not found/);
  });

  test("forkSession does not mutate the original handle", async () => {
    const mockForkSession = vi.mocked(realClaudeRewindSdk.forkSession);
    mockForkSession.mockResolvedValue({ sessionId: "brand-new-id" });

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
