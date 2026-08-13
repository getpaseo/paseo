import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { asInternals } from "../../test-utils/class-mocks.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { ACPAgentSession, type ACPSessionNotificationUsage } from "./acp-agent.js";
import {
  grokSessionSignalsPath,
  grokUsageFromSessionNotification,
  handleGrokExtensionNotification,
  mapGrokTurnUsage,
  readGrokContextUsage,
} from "./grok-acp-agent.js";

function createGrokSession(
  options: {
    extensionNotificationHandler?: typeof handleGrokExtensionNotification;
    sessionNotificationUsage?: ACPSessionNotificationUsage;
  } = {},
): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: "grok",
      cwd: "/tmp/paseo-grok-test",
    },
    {
      provider: "grok",
      logger: createTestLogger(),
      defaultCommand: ["grok", "agent", "stdio"],
      defaultModes: [],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      extensionNotificationHandler:
        options.extensionNotificationHandler ?? handleGrokExtensionNotification,
      sessionNotificationUsage: options.sessionNotificationUsage,
    },
  );
}

describe("mapGrokTurnUsage", () => {
  test("maps token buckets and cost ticks onto AgentUsage", () => {
    expect(
      mapGrokTurnUsage(
        {
          inputTokens: 183563,
          outputTokens: 5934,
          cachedReadTokens: 91648,
          costUsdTicks: 12_689_050_000,
        },
        {
          contextWindowUsedTokens: 131259,
          contextWindowMaxTokens: 500000,
        },
      ),
    ).toEqual({
      inputTokens: 183563,
      outputTokens: 5934,
      cachedInputTokens: 91648,
      totalCostUsd: 1.268905,
      contextWindowUsedTokens: 131259,
      contextWindowMaxTokens: 500000,
    });
  });
});

describe("readGrokContextUsage", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reads context window usage from Grok session signals", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-grok-home-"));
    homes.push(home);
    const cwd = "/Users/nexmoe/project";
    const sessionId = "session-signals";
    const path = grokSessionSignalsPath(cwd, sessionId, home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        contextTokensUsed: 331488,
        contextWindowTokens: 500000,
        contextWindowUsage: 66,
      }),
    );

    expect(readGrokContextUsage(cwd, sessionId, home)).toEqual({
      contextWindowUsedTokens: 331488,
      contextWindowMaxTokens: 500000,
    });
  });
});

describe("grokUsageFromSessionNotification", () => {
  test("maps Grok session/update _meta.totalTokens onto the context window", () => {
    expect(
      grokUsageFromSessionNotification(
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "pong" },
          },
          _meta: { totalTokens: 11493 },
        },
        {
          sessionId: "session-1",
          cwd: "/tmp/project",
          defaultContextWindow: 500000,
        },
      ),
    ).toEqual({
      contextWindowUsedTokens: 11493,
      contextWindowMaxTokens: 500000,
    });
  });
});

describe("handleGrokExtensionNotification", () => {
  test("emits usage_updated from _x.ai turn_completed with session signals", () => {
    const events = handleGrokExtensionNotification(
      "_x.ai/session/update",
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cachedReadTokens: 40,
            costUsdTicks: 10_000_000_000,
          },
        },
      },
      {
        sessionId: "session-1",
        cwd: "/tmp/project",
        provider: "grok",
        readSignals: () => ({
          contextWindowUsedTokens: 174000,
          contextWindowMaxTokens: 200000,
        }),
      },
    );

    expect(events).toEqual([
      {
        type: "usage_updated",
        provider: "grok",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 40,
          totalCostUsd: 1,
          contextWindowUsedTokens: 174000,
          contextWindowMaxTokens: 200000,
        },
      },
    ]);
  });

  test("ignores non-turn Grok extension updates", () => {
    expect(
      handleGrokExtensionNotification(
        "_x.ai/session/update",
        { update: { sessionUpdate: "task_backgrounded" } },
        { sessionId: "session-1", cwd: "/tmp/project", provider: "grok" },
      ),
    ).toEqual([]);
  });
});

describe("Grok ACP session usage", () => {
  test("emits usage_updated from Grok session/update _meta.totalTokens", async () => {
    const session = createGrokSession({
      sessionNotificationUsage: (params, context) =>
        grokUsageFromSessionNotification(params, {
          ...context,
          defaultContextWindow: 500000,
        }),
    });
    asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "pong" },
      },
      _meta: { totalTokens: 11493 },
    });

    expect(events.filter((event) => event.type === "usage_updated")).toEqual([
      {
        type: "usage_updated",
        provider: "grok",
        usage: {
          contextWindowUsedTokens: 11493,
          contextWindowMaxTokens: 500000,
        },
      },
    ]);
  });

  test("forwards Grok turn_completed extension usage onto subscribers", async () => {
    const session = createGrokSession({
      extensionNotificationHandler: (method, params, context) =>
        handleGrokExtensionNotification(method, params, {
          ...context,
          readSignals: () => ({
            contextWindowUsedTokens: 87000,
            contextWindowMaxTokens: 100000,
          }),
        }),
    });
    asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.extMethod("_x.ai/session/update", {
      sessionId: "session-1",
      update: {
        sessionUpdate: "turn_completed",
        usage: { inputTokens: 10, outputTokens: 4, costUsdTicks: 0 },
      },
    });

    expect(events.filter((event) => event.type === "usage_updated")).toEqual([
      {
        type: "usage_updated",
        provider: "grok",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalCostUsd: 0,
          contextWindowUsedTokens: 87000,
          contextWindowMaxTokens: 100000,
        },
      },
    ]);
  });
});
