import { describe, expect, test, vi } from "vitest";
import { wrapSessionProvider } from "./provider-registry.js";
import type { AgentSession } from "./agent-sdk-types.js";

/**
 * `wrapSessionProvider` re-declares the session surface by hand, so anything it forgets
 * is silently dropped for every aliased provider — Cursor, and every custom ACP profile.
 * That is not a type error, because the optional methods are optional.
 *
 * This is how `listMcpServers` went missing: the panel appeared for a Cursor agent, then
 * removed itself the moment it asked, because the wrapper had swallowed the method and
 * the daemon read that as "this provider cannot report".
 */
function createInnerSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    provider: "acp",
    id: "session-1",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsMcpStatus: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    run: vi.fn(),
    startTurn: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    streamHistory: vi.fn(),
    getRuntimeInfo: vi.fn(async () => ({ provider: "acp", sessionId: "session-1" })),
    getAvailableModes: vi.fn(async () => []),
    getCurrentMode: vi.fn(async () => null),
    setMode: vi.fn(),
    getPendingPermissions: vi.fn(() => []),
    respondToPermission: vi.fn(),
    describePersistence: vi.fn(() => null),
    interrupt: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as AgentSession;
}

describe("wrapSessionProvider", () => {
  test("forwards listMcpServers, which the MCP panel is gated on", async () => {
    const report = {
      servers: [{ name: "paseo", status: "connected" as const }],
      source: "live" as const,
    };
    const wrapped = wrapSessionProvider(
      "cursor-acp",
      createInnerSession({ listMcpServers: vi.fn(async () => report) }),
    );

    expect(wrapped.listMcpServers).toBeDefined();
    expect(await wrapped.listMcpServers?.()).toEqual(report);
  });

  test("leaves listMcpServers absent when the inner session has none", () => {
    const wrapped = wrapSessionProvider("cursor-acp", createInnerSession());

    // Absent has to stay absent: it is how the daemon tells a provider that cannot
    // report from one that can, and defaulting it would make the panel claim a source.
    expect(wrapped.listMcpServers).toBeUndefined();
  });

  test("carries every optional session method the inner session defines", () => {
    const optional = [
      "listCommands",
      "listMcpServers",
      "setModel",
      "setThinkingOption",
      "setFeature",
      "revertConversation",
      "revertFiles",
      "revertBoth",
      "tryHandleOutOfBand",
    ] as const;

    const inner = createInnerSession(
      Object.fromEntries(optional.map((name) => [name, vi.fn()])) as Partial<AgentSession>,
    );
    const wrapped = wrapSessionProvider("cursor-acp", inner);

    // A blanket check so a method added to the session interface but not to the wrapper
    // fails here rather than in whichever feature depended on it.
    for (const name of optional) {
      expect(wrapped[name], `${name} was dropped by wrapSessionProvider`).toBeDefined();
    }
  });
});
