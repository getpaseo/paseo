import { describe, expect, test, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";

interface TestClaudeSession extends AgentSession {
  translateMessageToEvents(message: SDKMessage): AgentStreamEvent[];
}

function createQueryMock(overrides: Record<string, unknown> = {}) {
  let endQuery: (() => void) | null = null;
  const queryEnded = new Promise<void>((resolve) => {
    endQuery = resolve;
  });
  const queryMock = {
    close: vi.fn(),
    return: vi.fn(async () => {
      endQuery?.();
    }),
    applyFlagSettings: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => undefined),
    [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void> {
      return {
        next: async () => {
          await queryEnded;
          return { value: undefined, done: true };
        },
      };
    },
    ...overrides,
  };
  return { queryFactory: vi.fn(() => queryMock), queryMock };
}

async function createSession(overrides: Record<string, unknown> = {}) {
  const { queryFactory, queryMock } = createQueryMock(overrides);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = (await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  })) as TestClaudeSession;
  return { session, queryMock };
}

/** A minimal `init` system message carrying the MCP list Claude reports at startup. */
function initMessage(mcpServers: Array<{ name: string; status: string }>): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: "session-1",
    apiKeySource: "user",
    claude_code_version: "1.0.0",
    cwd: process.cwd(),
    tools: [],
    mcp_servers: mcpServers,
    model: "claude-opus-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
  } as unknown as SDKMessage;
}

describe("ClaudeAgentSession MCP status", () => {
  test("advertises the capability so the app knows the panel has a source", async () => {
    const { session } = await createSession();
    expect(session.capabilities.supportsMcpStatus).toBe(true);
    await session.close();
  });

  test("maps every status Claude reports onto the protocol vocabulary", async () => {
    const { session } = await createSession({
      mcpServerStatus: vi.fn(async () => [
        { name: "ok", status: "connected", tools: [{ name: "a" }, { name: "b" }] },
        { name: "auth", status: "needs-auth", scope: "claudeai" },
        { name: "broken", status: "failed", error: "spawn ENOENT" },
        { name: "waiting", status: "pending" },
        { name: "off", status: "disabled" },
        { name: "future", status: "teleporting" },
      ]),
    });

    expect(await session.listMcpServers?.()).toEqual({
      servers: [
        { name: "ok", status: "connected", toolCount: 2 },
        { name: "auth", status: "needs_auth", scope: "claudeai" },
        { name: "broken", status: "failed", error: "spawn ENOENT" },
        { name: "waiting", status: "connecting" },
        { name: "off", status: "disabled" },
        { name: "future", status: "unknown" },
      ],
      source: "live",
    });
    await session.close();
  });

  test("falls back to the init list when the CLI rejects the control request", async () => {
    const { session } = await createSession({
      mcpServerStatus: vi.fn(async () => {
        throw new Error("Unknown control request: mcpServerStatus");
      }),
    });
    session.translateMessageToEvents(
      initMessage([
        { name: "paseo", status: "connected" },
        { name: "stripe", status: "needs-auth" },
      ]),
    );

    expect(await session.listMcpServers?.()).toEqual({
      servers: [
        { name: "paseo", status: "connected" },
        { name: "stripe", status: "needs_auth" },
      ],
      // Tagged `startup`, not `live`: these connections were true when the session
      // began and the panel says so rather than presenting them as current.
      source: "startup",
    });
    await session.close();
  });

  test("does not answer a transient failure with stale startup health", async () => {
    const { session } = await createSession({
      mcpServerStatus: vi.fn(async () => {
        throw new Error("Request timed out after 30000ms");
      }),
    });
    session.translateMessageToEvents(initMessage([{ name: "paseo", status: "connected" }]));

    // An init list exists, but a timeout is not evidence the servers are healthy —
    // answering with it would turn a real outage into a panel of green ticks.
    await expect(session.listMcpServers?.()).rejects.toThrow("timed out");
    await session.close();
  });

  test("surfaces the control-request failure when there is no init list to fall back to", async () => {
    const { session } = await createSession({
      mcpServerStatus: vi.fn(async () => {
        throw new Error("Unknown control request: mcpServerStatus");
      }),
    });

    await expect(session.listMcpServers?.()).rejects.toThrow("Unknown control request");
    await session.close();
  });

  test("prefers the live control request over the older init list", async () => {
    const { session } = await createSession({
      mcpServerStatus: vi.fn(async () => [{ name: "stripe", status: "connected" }]),
    });
    session.translateMessageToEvents(initMessage([{ name: "stripe", status: "needs-auth" }]));

    expect(await session.listMcpServers?.()).toEqual({
      servers: [{ name: "stripe", status: "connected" }],
      source: "live",
    });
    await session.close();
  });
});
