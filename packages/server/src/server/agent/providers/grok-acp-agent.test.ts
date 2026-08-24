import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { asInternals } from "../../test-utils/class-mocks.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { ACPAgentSession } from "./acp-agent.js";
import {
  grokSessionSignalsPath,
  grokUsageFromSessionNotification,
  readGrokContextUsage,
  readGrokDefaultContextWindow,
} from "./grok-acp-agent.js";

function createGrokSession(): ACPAgentSession {
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
      sessionNotificationUsage: (params, context) =>
        grokUsageFromSessionNotification(params, {
          ...context,
          defaultContextWindow: 500_000,
        }),
    },
  );
}

describe("readGrokDefaultContextWindow", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prefers grok-4.6 context window from the models cache", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-grok-home-"));
    homes.push(home);
    writeFileSync(
      join(home, "models_cache.json"),
      JSON.stringify({
        models: {
          "grok-code": { info: { context_window: 256_000 } },
          "grok-4.6": { info: { context_window: 500_000 } },
        },
      }),
    );

    expect(readGrokDefaultContextWindow(home)).toBe(500_000);
  });

  test("falls back to the first cached model with a context window", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-grok-home-"));
    homes.push(home);
    writeFileSync(
      join(home, "models_cache.json"),
      JSON.stringify({
        models: {
          "grok-code": { info: { context_window: 256_000 } },
        },
      }),
    );

    expect(readGrokDefaultContextWindow(home)).toBe(256_000);
  });

  test("returns null when the models cache is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-grok-home-"));
    homes.push(home);

    expect(readGrokDefaultContextWindow(home)).toBeNull();
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

  test("returns null for missing or corrupt Grok session signals", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-grok-home-"));
    homes.push(home);
    const cwd = "/Users/nexmoe/project";
    const sessionId = "session-corrupt";
    const path = grokSessionSignalsPath(cwd, sessionId, home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not-json");

    expect(readGrokContextUsage(cwd, "missing", home)).toBeNull();
    expect(readGrokContextUsage(cwd, sessionId, home)).toBeNull();
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

  test("prefers session signals over the default context window", () => {
    expect(
      grokUsageFromSessionNotification(
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "pong" },
          },
          _meta: { totalTokens: 87000 },
        },
        {
          sessionId: "session-1",
          cwd: "/tmp/project",
          defaultContextWindow: 500000,
          readSignals: () => ({
            contextWindowUsedTokens: 87000,
            contextWindowMaxTokens: 200000,
          }),
        },
      ),
    ).toEqual({
      contextWindowUsedTokens: 87000,
      contextWindowMaxTokens: 200000,
    });
  });

  test("ignores session updates without _meta.totalTokens", () => {
    expect(
      grokUsageFromSessionNotification(
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "pong" },
          },
        },
        {
          sessionId: "session-1",
          cwd: "/tmp/project",
          defaultContextWindow: 500000,
        },
      ),
    ).toBeUndefined();
  });
});

describe("Grok ACP session usage", () => {
  test("emits usage_updated from Grok session/update _meta.totalTokens", async () => {
    const session = createGrokSession();
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

  test("does not re-emit identical Grok context-window usage", async () => {
    const session = createGrokSession();
    asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    const notification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: "pong" },
      },
      _meta: { totalTokens: 11493 },
    };
    await session.sessionUpdate(notification);
    await session.sessionUpdate(notification);

    expect(events.filter((event) => event.type === "usage_updated")).toHaveLength(1);
  });
});
