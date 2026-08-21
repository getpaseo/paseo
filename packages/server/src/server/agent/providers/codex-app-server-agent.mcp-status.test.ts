import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  CodexAppServerAgentSession,
  CODEX_APP_SERVER_CAPABILITIES,
} from "./codex-app-server-agent.js";

/** A real `mcpServerStatus/list` payload, trimmed to the fields Paseo reads. */
const MCP_STATUS_RESPONSE = {
  data: [
    {
      name: "codex_apps",
      serverInfo: { name: "plugin-runtime", version: "0.1.0" },
      tools: { "vercel.search": {}, "asana.get": {} },
      authStatus: "bearerToken",
    },
    { name: "computer-use", serverInfo: null, tools: {}, authStatus: "unsupported" },
    {
      name: "salt-brain",
      serverInfo: { name: "salt-brain", version: "1.2.3" },
      tools: { a: {}, b: {}, c: {} },
      authStatus: "unsupported",
    },
  ],
};

interface SessionInternals {
  connected: boolean;
  currentThreadId: string | null;
  client: { request: (method: string, params?: unknown) => Promise<unknown> } | null;
}

function createSession(response: unknown = MCP_STATUS_RESPONSE): {
  session: CodexAppServerAgentSession;
  calls: string[];
} {
  const calls: string[] = [];
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/tmp/codex-mcp-status-test" },
    null,
    createTestLogger(),
    () => {
      throw new Error("Test session must not spawn a Codex app-server");
    },
  );
  const internals = session as unknown as SessionInternals;
  internals.connected = true;
  internals.currentThreadId = "test-thread";
  internals.client = {
    request: async (method: string) => {
      calls.push(method);
      return method === "mcpServerStatus/list" ? response : {};
    },
  };
  return { session, calls };
}

describe("Codex MCP status", () => {
  test("advertises the capability so the app knows the panel has a source", () => {
    expect(CODEX_APP_SERVER_CAPABILITIES.supportsMcpStatus).toBe(true);
  });

  test("reads live status over the app-server connection the session already holds", async () => {
    const { session, calls } = createSession();

    expect(await session.listMcpServers()).toEqual({
      servers: [
        { name: "codex_apps", status: "connected", toolCount: 2 },
        // serverInfo is null and there is no auth signal, so Codex is not saying why.
        { name: "computer-use", status: "unknown" },
        { name: "salt-brain", status: "connected", toolCount: 3 },
      ],
      source: "live",
    });
    // No subprocess: the status comes back over the connection that already exists.
    expect(calls).toEqual(["mcpServerStatus/list"]);
  });

  test("separates a server awaiting a login from one Codex will not explain", async () => {
    const { session } = createSession({
      data: [
        { name: "signin", serverInfo: null, tools: {}, authStatus: "needsAuth" },
        { name: "broken", serverInfo: null, tools: {}, authStatus: "unsupported" },
      ],
    });

    expect((await session.listMcpServers()).servers).toEqual([
      { name: "signin", status: "needs_auth" },
      { name: "broken", status: "unknown" },
    ]);
  });

  test("reports an empty list when Codex has no MCP servers", async () => {
    const { session } = createSession({ data: [] });
    expect(await session.listMcpServers()).toEqual({ servers: [], source: "live" });
  });

  test("fails loudly when the app-server connection is not up yet", async () => {
    const { session } = createSession();
    (session as unknown as SessionInternals).client = null;

    await expect(session.listMcpServers()).rejects.toThrow("connection is not ready");
  });
});
