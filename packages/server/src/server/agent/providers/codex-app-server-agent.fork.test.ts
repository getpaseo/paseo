import { describe, expect, test, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentPersistenceHandle, AgentSession } from "../agent-sdk-types.js";

function createFakeChildProcess(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.exitCode = 0;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

interface FakeCodexClient {
  request: (method: string, params?: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
  dispose: () => Promise<void>;
}

/** A `thread/fork` response shaped to satisfy the Zod parser. */
function fakeForkResponse(threadId: string) {
  return {
    thread: { id: threadId, sessionId: "forked-session", forkedFromId: null, turns: [] },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp",
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: null,
    sandbox: { type: "workspaceWrite", networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: null,
  };
}

/**
 * Test double that injects the app-server child + scripted client via the
 * provided `deps` seams and captures the handle `forkSession` resumes — so the
 * tests never spy on an own method or reach into private internals.
 */
class TestCodexAgentClient extends CodexAppServerAgentClient {
  resumedHandle: AgentPersistenceHandle | null = null;
  resumedSession: AgentSession = {} as unknown as AgentSession;

  static create(fakeClient: FakeCodexClient): TestCodexAgentClient {
    return new TestCodexAgentClient(createTestLogger(), undefined, {
      _createCodexClient: () => fakeClient as never,
      _spawnAppServer: async () => createFakeChildProcess(),
    });
  }

  override async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    this.resumedHandle = handle;
    return this.resumedSession;
  }
}

describe("CodexAppServerAgentClient.forkSession", () => {
  test("capabilities.supportsFork is true", () => {
    const client = new CodexAppServerAgentClient(createTestLogger());
    expect(client.capabilities.supportsFork).toBe(true);
  });

  test("forks the thread via thread/fork and resumes with the new thread id", async () => {
    const recordedRequests: Array<{ method: string; params: unknown }> = [];
    const fakeClient: FakeCodexClient = {
      request: async (method, params) => {
        recordedRequests.push({ method, params });
        if (method === "thread/fork") {
          return fakeForkResponse("new-forked-thread-abc");
        }
        return {};
      },
      notify: () => {},
      dispose: async () => {},
    };

    const client = TestCodexAgentClient.create(fakeClient);

    const handle: AgentPersistenceHandle = {
      provider: "codex",
      sessionId: "source-thread-123",
      nativeHandle: "source-thread-123",
      metadata: { cwd: "/workspace/project", model: "gpt-5.4" },
    };

    const result = await client.forkSession!(handle, {});

    expect(recordedRequests[0]).toMatchObject({ method: "initialize" });
    const forkCall = recordedRequests.find((r) => r.method === "thread/fork");
    expect(forkCall?.params).toMatchObject({
      threadId: "source-thread-123",
      cwd: "/workspace/project",
      model: "gpt-5.4",
      excludeTurns: false,
      persistExtendedHistory: true,
    });
    // Resumes the NEW forked thread id; original handle is not mutated.
    expect(client.resumedHandle).toMatchObject({
      provider: "codex",
      sessionId: "new-forked-thread-abc",
      nativeHandle: "new-forked-thread-abc",
    });
    expect(result).toBe(client.resumedSession);
  });

  test("uses handle.sessionId as the source thread id", async () => {
    const recordedForkParams: unknown[] = [];
    const fakeClient: FakeCodexClient = {
      request: async (method, params) => {
        if (method === "thread/fork") {
          recordedForkParams.push(params);
          return fakeForkResponse("forked-xyz");
        }
        return {};
      },
      notify: () => {},
      dispose: async () => {},
    };

    const client = TestCodexAgentClient.create(fakeClient);
    const handle: AgentPersistenceHandle = {
      provider: "codex",
      sessionId: "my-thread-id",
      nativeHandle: "my-thread-id",
      metadata: {},
    };

    await client.forkSession!(handle, {});

    expect(recordedForkParams[0]).toMatchObject({
      threadId: "my-thread-id",
      cwd: null,
      model: null,
    });
  });

  test("does not mutate the original thread (whole-conversation fork: no rollback)", async () => {
    let forkCallCount = 0;
    let rollbackCallCount = 0;
    const fakeClient: FakeCodexClient = {
      request: async (method) => {
        if (method === "thread/fork") {
          forkCallCount += 1;
          return fakeForkResponse("forked-id");
        }
        if (method === "thread/rollback") {
          rollbackCallCount += 1;
          return { thread: { id: "rolled-back", turns: [] } };
        }
        return {};
      },
      notify: () => {},
      dispose: async () => {},
    };

    const client = TestCodexAgentClient.create(fakeClient);
    const handle: AgentPersistenceHandle = {
      provider: "codex",
      sessionId: "original-thread",
      nativeHandle: "original-thread",
      metadata: {},
    };

    await client.forkSession!(handle, {});

    // No upToMessageId → fork the whole thread, never roll back.
    expect(forkCallCount).toBe(1);
    expect(rollbackCallCount).toBe(0);
  });
});
