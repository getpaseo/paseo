import { describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-mcp-status-test-"));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

async function withSession(
  statusResponse: Record<string, unknown>,
  assertions: (input: {
    session: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>>;
    openCodeClient: TestOpenCodeClient;
    cwd: string;
  }) => Promise<void>,
): Promise<void> {
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.mcpStatusResponse = { data: statusResponse };
  runtime.enqueueClient(openCodeClient);
  const cwd = tmpCwd();
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  try {
    const session = await client.createSession({ provider: "opencode", cwd });
    try {
      await assertions({ session, openCodeClient, cwd });
    } finally {
      await session.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("OpenCode MCP status", () => {
  test("advertises the capability so the app knows the panel has a source", async () => {
    await withSession({}, async ({ session }) => {
      expect(session.capabilities.supportsMcpStatus).toBe(true);
    });
  });

  test("maps every OpenCode status variant onto the protocol vocabulary", async () => {
    await withSession(
      {
        ok: { status: "connected" },
        off: { status: "disabled" },
        broken: { status: "failed", error: "connect ECONNREFUSED" },
        signin: { status: "needs_auth" },
        // OpenCode's second flavour of "authenticate first" collapses onto the same
        // status, because the row a reader sees is the same either way.
        register: { status: "needs_client_registration", error: "no client id" },
        future: { status: "levitating" },
      },
      async ({ session }) => {
        expect(await session.listMcpServers?.()).toEqual({
          servers: [
            { name: "ok", status: "connected" },
            { name: "off", status: "disabled" },
            { name: "broken", status: "failed", error: "connect ECONNREFUSED" },
            { name: "signin", status: "needs_auth" },
            // The error is dropped: the panel draws every error in the danger token, and
            // this is a warning-tone status. Two tokens for one status is forbidden.
            { name: "register", status: "needs_auth" },
            { name: "future", status: "unknown" },
          ],
          source: "live",
        });
      },
    );
  });

  test("scopes the status query to the agent's own directory", async () => {
    await withSession({ ok: { status: "connected" } }, async ({ session, openCodeClient, cwd }) => {
      await session.listMcpServers?.();
      expect(openCodeClient.calls.mcpStatus).toEqual([{ directory: cwd }]);
    });
  });

  test("returns an empty list when OpenCode has no MCP servers", async () => {
    await withSession({}, async ({ session }) => {
      expect(await session.listMcpServers?.()).toEqual({ servers: [], source: "live" });
    });
  });
});
