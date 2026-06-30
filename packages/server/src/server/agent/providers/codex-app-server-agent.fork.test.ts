import { describe, expect, test, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentPersistenceHandle, AgentSession } from "../agent-sdk-types.js";
import { asInternals as castInternals } from "../../test-utils/class-mocks.js";

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

describe("CodexAppServerAgentClient.forkSession", () => {
  test("capabilities.supportsFork is true", () => {
    const client = new CodexAppServerAgentClient(createTestLogger());
    expect(client.capabilities.supportsFork).toBe(true);
  });

  test("forks the thread via thread/fork and resumes with the new thread id", async () => {
    const recordedRequests: Array<{ method: string; params: unknown }> = [];

    const fakeClient = {
      request: async (method: string, params?: unknown) => {
        recordedRequests.push({ method, params });
        if (method === "initialize") return {};
        if (method === "thread/fork") {
          return {
            thread: {
              id: "new-forked-thread-abc",
              sessionId: "new-forked-session",
              forkedFromId: (params as Record<string, unknown>).threadId,
              turns: [],
            },
            model: "gpt-5.4",
            modelProvider: "openai",
            serviceTier: null,
            cwd: "/workspace/project",
            runtimeWorkspaceRoots: [],
            instructionSources: [],
            approvalPolicy: "on-request",
            approvalsReviewer: null,
            sandbox: { type: "workspaceWrite", networkAccess: false },
            activePermissionProfile: null,
            reasoningEffort: null,
          };
        }
        return {};
      },
      notify: () => {},
      dispose: async () => {},
    };

    const client = new CodexAppServerAgentClient(createTestLogger(), undefined, {
      _createCodexClient: () => fakeClient,
    });

    // Override spawnAppServer to return a fake child
    castInternals<{ spawnAppServer: () => Promise<ChildProcessWithoutNullStreams> }>(
      client,
    ).spawnAppServer = async () => createFakeChildProcess();

    // Mock resumeSession to avoid needing a full session lifecycle
    const fakeSession = { sessionId: "new-forked-thread-abc" } as unknown as AgentSession;
    const resumeMock = vi.spyOn(client, "resumeSession").mockResolvedValue(fakeSession);

    const handle: AgentPersistenceHandle = {
      provider: "codex",
      sessionId: "source-thread-123",
      nativeHandle: "source-thread-123",
      metadata: {
        cwd: "/workspace/project",
        model: "gpt-5.4",
      },
    };

    const result = await client.forkSession!(handle, {});

    // Verify initialize was called first
    expect(recordedRequests[0]).toMatchObject({ method: "initialize" });

    // Verify thread/fork was called with correct params
    const forkCall = recordedRequests.find((r) => r.method === "thread/fork");
    expect(forkCall).toBeDefined();
    expect(forkCall!.params).toMatchObject({
      threadId: "source-thread-123",
      cwd: "/workspace/project",
      model: "gpt-5.4",
      serviceTier: null,
      excludeTurns: false,
      persistExtendedHistory: true,
    });

    // Verify resumeSession was called with the new forked thread id
    expect(resumeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        sessionId: "new-forked-thread-abc",
        nativeHandle: "new-forked-thread-abc",
      }),
      undefined,
      undefined,
    );

    // Verify result is the resumed session
    expect(result).toBe(fakeSession);

    resumeMock.mockRestore();
  });

  test("uses handle.sessionId as the source thread id", async () => {
    const recordedForkParams: unknown[] = [];

    const fakeClient = {
      request: async (method: string, params?: unknown) => {
        if (method === "initialize") return {};
        if (method === "thread/fork") {
          recordedForkParams.push(params);
          return {
            thread: {
              id: "forked-xyz",
              sessionId: "forked-session",
              forkedFromId: (params as Record<string, unknown>).threadId,
              turns: [],
            },
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
        return {};
      },
      notify: () => {},
      dispose: async () => {},
    };

    const client = new CodexAppServerAgentClient(createTestLogger(), undefined, {
      _createCodexClient: () => fakeClient,
    });

    castInternals<{ spawnAppServer: () => Promise<ChildProcessWithoutNullStreams> }>(
      client,
    ).spawnAppServer = async () => createFakeChildProcess();

    const fakeSession = {} as unknown as AgentSession;
    vi.spyOn(client, "resumeSession").mockResolvedValue(fakeSession);

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

  test("does not mutate the original thread (fork is non-destructive)", async () => {
    let forkCallCount = 0;
    let rollbackCallCount = 0;

    const fakeClient = {
      request: async (method: string, params?: unknown) => {
        if (method === "initialize") return {};
        if (method === "thread/fork") {
          forkCallCount++;
          return {
            thread: {
              id: "forked-id",
              sessionId: "forked-session",
              forkedFromId: (params as Record<string, unknown>).threadId,
              turns: [],
            },
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
        if (method === "thread/rollback") {
          rollbackCallCount++;
          return { thread: { id: "rolled-back", turns: [] } };
        }
        return {};
      },
      notify: () => {},
      dispose: async () => {},
    };

    const client = new CodexAppServerAgentClient(createTestLogger(), undefined, {
      _createCodexClient: () => fakeClient,
    });

    castInternals<{ spawnAppServer: () => Promise<ChildProcessWithoutNullStreams> }>(
      client,
    ).spawnAppServer = async () => createFakeChildProcess();

    vi.spyOn(client, "resumeSession").mockResolvedValue({} as unknown as AgentSession);

    const handle: AgentPersistenceHandle = {
      provider: "codex",
      sessionId: "original-thread",
      nativeHandle: "original-thread",
      metadata: {},
    };

    await client.forkSession!(handle, {});

    // Whole-conversation fork: only fork, no rollback
    expect(forkCallCount).toBe(1);
    expect(rollbackCallCount).toBe(0);
  });
});
