import type { SessionInfo } from "@opencode-ai/client";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent, ImportProviderSessionContext } from "../../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "../opencode-v2-agent.js";
import {
  TestOpenCodeV2Client,
  TestOpenCodeV2Harness,
} from "./test-utils/test-opencode-v2-harness.js";

const TEST_MODEL = "baseten/deepseek-ai/DeepSeek-V4-Flash-0731";

function sessionInfo(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    projectID: "project-1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/workspace/repo" },
    ...extra,
  } as SessionInfo;
}

function buildImportContext(cwd: string): ImportProviderSessionContext {
  return {
    config: { provider: "opencode-v2", cwd },
    storedConfig: { provider: "opencode-v2", cwd },
  };
}

async function createClient(configure?: (openCode: TestOpenCodeV2Client) => void): Promise<{
  client: OpenCodeV2AgentClient;
  openCode: TestOpenCodeV2Client;
  runtime: TestOpenCodeV2Harness;
}> {
  const runtime = new TestOpenCodeV2Harness();
  const openCode = new TestOpenCodeV2Client();
  configure?.(openCode);
  runtime.enqueueClient(openCode);
  const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  return { client, openCode, runtime };
}

async function collectHistory(
  iterator: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of iterator) {
    events.push(event);
  }
  return events;
}

describe("OpenCodeV2 resume/history/import/archive", () => {
  test("describePersistence includes modeId, model, and thinkingOptionId in metadata", async () => {
    const { client } = await createClient();
    const session = await client.createSession({
      provider: "opencode-v2",
      cwd: "/workspace/repo",
      model: TEST_MODEL,
      modeId: "plan",
      thinkingOptionId: "high",
    });

    const handle = session.describePersistence();
    expect(handle).toEqual({
      provider: "opencode-v2",
      sessionId: "session-1",
      nativeHandle: "session-1",
      metadata: {
        cwd: "/workspace/repo",
        modeId: "plan",
        model: TEST_MODEL,
        thinkingOptionId: "high",
      },
    });
    await session.close();
  });

  test("describePersistence omits unset mode/model/thinkingOptionId", async () => {
    const { client } = await createClient();
    const session = await client.createSession({
      provider: "opencode-v2",
      cwd: "/workspace/repo",
    });

    const handle = session.describePersistence();
    expect(handle?.metadata).toEqual({ cwd: "/workspace/repo" });
    await session.close();
  });

  test("resumeSession restores mode/model/thinkingOptionId from persistence metadata", async () => {
    const { client } = await createClient();
    const session = await client.resumeSession({
      provider: "opencode-v2",
      sessionId: "session-1",
      nativeHandle: "session-1",
      metadata: {
        cwd: "/workspace/repo",
        modeId: "plan",
        model: TEST_MODEL,
        thinkingOptionId: "high",
      },
    });

    const runtimeInfo = await session.getRuntimeInfo();
    expect(runtimeInfo).toMatchObject({
      sessionId: "session-1",
      modeId: "plan",
      model: TEST_MODEL,
      thinkingOptionId: "high",
    });
    await session.close();
  });

  test("resumeSession overrides take precedence over persistence metadata", async () => {
    const { client } = await createClient();
    const session = await client.resumeSession(
      {
        provider: "opencode-v2",
        sessionId: "session-1",
        nativeHandle: "session-1",
        metadata: {
          cwd: "/workspace/repo",
          modeId: "plan",
          model: "baseten/old-model",
          thinkingOptionId: "low",
        },
      },
      {
        modeId: "build",
        model: TEST_MODEL,
        thinkingOptionId: "high",
      },
    );

    const runtimeInfo = await session.getRuntimeInfo();
    expect(runtimeInfo).toMatchObject({
      modeId: "build",
      model: TEST_MODEL,
      thinkingOptionId: "high",
    });
    await session.close();
  });

  test("resumeSession verifies the session via session.get and reconciles MCP servers", async () => {
    const { client, openCode } = await createClient((openCodeClient) => {
      openCodeClient.mcpListResponse = {
        location: {
          directory: "/workspace/repo",
          project: { id: "project-1", directory: "/workspace/repo", canonical: "/workspace/repo" },
        },
        data: [],
      };
    });
    const session = await client.resumeSession(
      {
        provider: "opencode-v2",
        sessionId: "session-1",
        nativeHandle: "session-1",
        metadata: { cwd: "/workspace/repo" },
      },
      {
        mcpServers: {
          "echo-server": {
            type: "stdio",
            command: "node",
            args: ["/tmp/op2-echo-mcp.mjs"],
          },
        },
      },
    );

    expect(openCode.calls.sessionGet).toEqual([{ sessionID: "session-1" }]);
    expect(openCode.calls.mcpAdd.length).toBeGreaterThan(0);
    expect(openCode.calls.mcpConnect.length).toBeGreaterThan(0);
    await session.close();
  });

  test("resumeSession requires the original working directory", async () => {
    const { client } = await createClient();
    await expect(
      client.resumeSession({
        provider: "opencode-v2",
        sessionId: "session-1",
        nativeHandle: "session-1",
        metadata: {},
      }),
    ).rejects.toThrow("requires the original working directory");
  });

  test("listImportableSessions lists sessions from session.list with a cwd filter", async () => {
    const { client, openCode } = await createClient((openCodeClient) => {
      openCodeClient.sessionListResponse = {
        data: [
          sessionInfo("session-1", {
            title: "First session",
            time: { created: 100, updated: 200 },
            location: { directory: "/workspace/repo" },
          }),
          sessionInfo("session-2", {
            title: "  ",
            time: { created: 50, updated: 60 },
            location: { directory: "/other/dir" },
          }),
        ],
        cursor: {},
      };
    });

    const importable = await client.listImportableSessions({ cwd: "/workspace/repo" });

    expect(openCode.calls.sessionList).toEqual([{ directory: "/workspace/repo", limit: 200 }]);
    expect(importable).toEqual([
      {
        providerHandleId: "session-1",
        cwd: "/workspace/repo",
        title: "First session",
        firstPromptPreview: null,
        lastPromptPreview: null,
        lastActivityAt: new Date(200),
      },
    ]);
  });

  test("listImportableSessions sorts by last activity and honors the limit", async () => {
    const { client } = await createClient((openCodeClient) => {
      openCodeClient.sessionListResponse = {
        data: [
          sessionInfo("old", { time: { created: 1, updated: 2 } }),
          sessionInfo("new", { time: { created: 3, updated: 4 } }),
          sessionInfo("middle", { time: { created: 2, updated: 3 } }),
        ],
        cursor: {},
      };
    });

    const importable = await client.listImportableSessions({ limit: 2 });

    expect(importable.map((session) => session.providerHandleId)).toEqual(["new", "middle"]);
    expect(importable[0]?.lastActivityAt).toEqual(new Date(4));
  });

  test("importSession imports a real session with resolved mode/model and replayed history", async () => {
    const { client, openCode, runtime } = await createClient((openCodeClient) => {
      openCodeClient.sessionGetResponse = sessionInfo("session-1", {
        title: "Imported session",
        agent: "plan",
        model: { providerID: "baseten", id: "deepseek-ai/DeepSeek-V4-Flash-0731" },
        time: { created: 100, updated: 200 },
      });
      openCodeClient.messageListResponse = {
        data: [
          {
            id: "msg_user",
            type: "user",
            text: "Hello there",
            time: { created: 1 },
          },
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "plan",
            model: { providerID: "baseten", id: "deepseek-ai/DeepSeek-V4-Flash-0731" },
            time: { created: 2 },
            content: [{ type: "text", text: "Hi back", state: {} }],
          },
        ],
        cursor: {},
      };
    });
    // importSession resolves mode/model via session.get + message.list, then
    // resumeSession (inside importSessionFromPersistence) creates a second
    // client for the session's streamHistory. Both hit the same server, so the
    // same fake client must serve both.
    runtime.enqueueClient(openCode);

    const imported = await client.importSession(
      { providerHandleId: "session-1", cwd: "/workspace/repo" },
      buildImportContext("/workspace/repo"),
    );

    // importSession resolves mode/model via session.get + message.list, and
    // resumeSession (inside importSessionFromPersistence) verifies the session
    // via session.get and streams history via message.list — so each endpoint
    // is hit once per phase.
    expect(openCode.calls.sessionGet).toEqual([
      { sessionID: "session-1" },
      { sessionID: "session-1" },
    ]);
    expect(openCode.calls.messageList).toEqual([
      { sessionID: "session-1" },
      { sessionID: "session-1" },
    ]);
    expect(imported.persistence).toEqual({
      provider: "opencode-v2",
      sessionId: "session-1",
      nativeHandle: "session-1",
      metadata: {
        provider: "opencode-v2",
        cwd: "/workspace/repo",
        modeId: "plan",
        model: TEST_MODEL,
        title: "Imported session",
      },
    });
    expect(imported.config).toMatchObject({
      provider: "opencode-v2",
      cwd: "/workspace/repo",
      modeId: "plan",
      model: TEST_MODEL,
      title: "Imported session",
    });
    expect(imported.timeline).toEqual([
      {
        timestamp: "1970-01-01T00:00:01.000Z",
        item: { type: "user_message", text: "Hello there", messageId: "msg_user" },
      },
      {
        timestamp: "1970-01-01T00:00:02.000Z",
        item: { type: "assistant_message", text: "Hi back", messageId: "msg_assistant" },
      },
    ]);
    await imported.session.close();
  });

  test("importSession falls back to mode/model from assistant messages when the session omits them", async () => {
    const { client, openCode, runtime } = await createClient((openCodeClient) => {
      openCodeClient.sessionGetResponse = sessionInfo("session-1", {
        title: "No metadata session",
      });
      openCodeClient.messageListResponse = {
        data: [
          {
            id: "msg_user",
            type: "user",
            text: "Hello",
            time: { created: 1 },
          },
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "openai", id: "gpt-5.5" },
            time: { created: 2 },
            content: [{ type: "text", text: "Hi", state: {} }],
          },
        ],
        cursor: {},
      };
    });
    runtime.enqueueClient(openCode);

    const imported = await client.importSession(
      { providerHandleId: "session-1", cwd: "/workspace/repo" },
      buildImportContext("/workspace/repo"),
    );

    expect(imported.config).toMatchObject({
      modeId: "build",
      model: "openai/gpt-5.5",
    });
    await imported.session.close();
  });

  test("archiveNativeSession and unarchiveNativeSession are best-effort no-ops", async () => {
    const { client, openCode } = await createClient();
    const handle = {
      provider: "opencode-v2" as const,
      sessionId: "session-1",
      nativeHandle: "session-1",
      metadata: { cwd: "/workspace/repo" },
    };

    await client.archiveNativeSession(handle);
    await client.unarchiveNativeSession(handle);

    // v2 has no session archive API; the no-op must not delete or mutate the
    // durable native session.
    expect(openCode.calls.sessionRemove).toEqual([]);
    expect(openCode.calls.sessionGet).toEqual([]);
  });

  test("streamHistory replays compaction and synthetic messages", async () => {
    const { client } = await createClient((openCodeClient) => {
      openCodeClient.messageListResponse = {
        data: [
          {
            id: "msg_compact",
            type: "compaction",
            status: "completed",
            reason: "auto",
            summary: "summarized",
            recent: "recent",
            time: { created: 1 },
          },
          {
            id: "msg_synthetic",
            type: "synthetic",
            text: "Subagent result",
            time: { created: 2 },
          },
        ],
        cursor: {},
      };
    });
    const session = await client.resumeSession({
      provider: "opencode-v2",
      sessionId: "session-1",
      nativeHandle: "session-1",
      metadata: { cwd: "/workspace/repo" },
    });

    const history = await collectHistory(session.streamHistory());
    expect(history).toEqual([
      {
        type: "timeline",
        provider: "opencode-v2",
        timestamp: "1970-01-01T00:00:01.000Z",
        item: { type: "compaction", status: "completed", trigger: "auto" },
      },
      {
        type: "timeline",
        provider: "opencode-v2",
        timestamp: "1970-01-01T00:00:02.000Z",
        item: { type: "assistant_message", text: "Subagent result", messageId: "msg_synthetic" },
      },
    ]);
    await session.close();
  });
});
