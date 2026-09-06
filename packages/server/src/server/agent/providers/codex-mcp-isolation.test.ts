import { describe, expect, it } from "vitest";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

describe("Codex host MCP isolation", () => {
  it("disables inherited user servers while retaining the injected routing catalog", async () => {
    const server = createFakeCodexAppServer({
      "config/read": () => ({ config: { mcp_servers: { private_mail: { command: "mail-mcp" } } } }),
    });
    const session = new CodexAppServerAgentSession(
      {
        provider: "codex",
        cwd: "/tmp/isolated-host",
        inheritMcpServers: false,
        mcpServers: { paseo: { type: "http", url: "http://127.0.0.1/mcp" } },
        toolPolicy: { preapproved: [{ kind: "mcp", server: "paseo", tool: "list_paseo_hosts" }] },
      },
      null,
      createTestLogger(),
      async () => server.child,
    );
    try {
      await session.connect();
      await session.startTurn("List hosts");
      const start = await server.waitForRequest("thread/start");
      expect(start).toMatchObject({
        config: {
          mcp_servers: {
            private_mail: { enabled: false },
            paseo: { enabled_tools: ["list_paseo_hosts"] },
          },
        },
      });
    } finally {
      await session.close();
    }
  });

  it("refuses an isolated host when effective configuration cannot be read", async () => {
    const server = createFakeCodexAppServer({
      "config/read": () => ({ __jsonRpcError: { code: -32603, message: "config unavailable" } }),
    });
    const session = new CodexAppServerAgentSession(
      { provider: "codex", cwd: "/tmp/isolated-host", inheritMcpServers: false },
      null,
      createTestLogger(),
      async () => server.child,
    );
    try {
      await expect(session.connect()).rejects.toThrow("config unavailable");
    } finally {
      await session.close();
    }
  });
});
