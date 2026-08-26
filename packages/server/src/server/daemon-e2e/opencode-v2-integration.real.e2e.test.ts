import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient, type WaitForFinishResult } from "../test-utils/daemon-client.js";
import { canRunRealProvider, createRealProviderClients } from "./real-provider-test-config.js";
import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";

const MODEL = "baseten/deepseek-ai/DeepSeek-V4-Flash-0731";
const MCP_SENTINEL = "cross007-mcp";
const SHELL_SENTINEL = "cross007-shell";
const SUBAGENT_SENTINEL = "cross007-child";

/**
 * Trivial stdio MCP echo server. `jsonrpc: "2.0"` is required on every
 * response or the MCP SDK silently drops it and the call times out.
 */
const ECHO_MCP_SOURCE = `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const id = req.id;
  const method = req.method;
  const params = req.params || {};
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "op2-echo-mcp", version: "1.0.0" } } });
  } else if (method === "notifications/initialized") {
    // no response expected
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{ name: "echo", description: "Echo back the input text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  } else if (method === "tools/call") {
    const text = params.arguments?.text ?? "";
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo:" + text }], isError: false } });
  } else {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
`;

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-v2-integration-"));
}

async function allowPermission(
  client: DaemonClient,
  agentId: string,
  permission: AgentPermissionRequest,
): Promise<void> {
  if (permission.kind === "question") {
    throw new Error(
      `Unexpected question permission while waiting for tool call: ${permission.id} ${permission.title}`,
    );
  }
  await client.respondToPermission(agentId, permission.id, {
    behavior: "allow",
    message: "Approved by integration test",
  });
}

/**
 * Wait for the agent to reach idle, resolving every tool permission that
 * surfaces along the way. A single turn can raise several permission requests
 * (one per shell/edit action), so this loops until the agent actually idles.
 *
 * Unlike v1 providers, a v2 permission reply is resolved asynchronously on the
 * opencode2 server, so after replying we must wait for the pending permission
 * to actually clear before the next waitForFinish (which returns immediately
 * while any permission is pending).
 */
async function waitForIdleResolvingPermissions(
  client: DaemonClient,
  agentId: string,
  timeoutMs: number,
): Promise<WaitForFinishResult> {
  const deadline = Date.now() + timeoutMs;
  const handledPermissionIds = new Set<string>();

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await client.waitForFinish(agentId, Math.min(remaining, 45_000));
    if (result.status !== "permission") {
      return result;
    }

    const pendingPermissions = result.final?.pendingPermissions ?? [];
    if (pendingPermissions.length === 0) {
      throw new Error("waitForFinish reported permission but no pending permissions were present");
    }

    let resolvedAny = false;
    for (const permission of pendingPermissions) {
      if (handledPermissionIds.has(permission.id)) {
        continue;
      }
      handledPermissionIds.add(permission.id);
      await allowPermission(client, agentId, permission);
      resolvedAny = true;
    }

    if (!resolvedAny) {
      // Every pending permission was already replied to; the opencode2 server
      // is still processing the reply. Wait for the pending set to clear
      // before looping again, otherwise waitForFinish returns the stale
      // permission immediately.
      const cleared = await waitForHandledPermissionsCleared(
        client,
        agentId,
        handledPermissionIds,
        Math.max(1, deadline - Date.now()),
      );
      if (!cleared) {
        return {
          status: "timeout",
          final: null,
          error: `Timed out waiting for permission ${Array.from(handledPermissionIds).join(", ")} to resolve`,
          lastMessage: null,
        };
      }
    }
  }

  return {
    status: "timeout",
    final: null,
    error: `Timed out waiting for idle after ${timeoutMs}ms`,
    lastMessage: null,
  };
}

async function waitForHandledPermissionsCleared(
  client: DaemonClient,
  agentId: string,
  handledPermissionIds: ReadonlySet<string>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await client.fetchAgent({ agentId }).catch(() => null);
    const pending = snapshot?.agent.pendingPermissions ?? [];
    const stillPending = pending.some((permission) => handledPermissionIds.has(permission.id));
    if (!stillPending) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function createHarness(): Promise<{
  client: DaemonClient;
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>;
}> {
  const logger = pino({ level: "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: createRealProviderClients(["opencode-v2"], logger),
    logger,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    // Report a current app version so the daemon exposes all providers
    // (opencode-v2 included) instead of only the legacy provider set.
    appVersion: "0.5.2",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "opencode-v2-integration" } });
  return { client, daemon };
}

/**
 * Create the agent, retrying the transient provider-unavailable cold-start
 * (the opencode2 binary can briefly report unavailable right after a daemon
 * spawn; see library/opencode-v2-mcp.md gotcha #5).
 */
async function createAgentWithRetry(
  client: DaemonClient,
  options: Parameters<DaemonClient["createAgent"]>[0],
): Promise<Awaited<ReturnType<DaemonClient["createAgent"]>>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await client.createAgent(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("is not available") || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

describe("daemon E2E (real opencode-v2) - cross-feature integration", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("opencode-v2");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("one session spans MCP injection + permission + subagent", async () => {
    const cwd = tmpCwd();
    const mcpScript = path.join(cwd, "echo-mcp.mjs");
    writeFileSync(mcpScript, ECHO_MCP_SOURCE, "utf8");
    const { client, daemon } = await createHarness();
    let agent: Awaited<ReturnType<DaemonClient["createAgent"]>> | null = null;
    try {
      // Load the opencode-v2 catalog (modes/models) so createAgent can
      // validate the requested mode against the real server's agent list.
      await client.refreshProvidersSnapshot({ providers: ["opencode-v2"], cwd });
      agent = await createAgentWithRetry(client, {
        provider: "opencode-v2",
        cwd,
        title: "OpenCode2 cross-feature integration",
        model: MODEL,
        // No explicit modeId: the opencode2 server reports no agents via
        // agent.list (modes are empty), so the provider uses its default
        // agent. This mirrors what the app sends for opencode-v2.
        mcpServers: {
          "echo-server": { type: "stdio", command: "node", args: [mcpScript] },
        },
      });

      // Turn 1: MCP echo tool + a shell command that raises a permission.
      await client.sendMessage(
        agent.id,
        [
          `Call the echo tool from the echo-server MCP server with the exact text '${MCP_SENTINEL}'.`,
          `Then use the shell tool to run the exact command: echo ${SHELL_SENTINEL} > cross007.txt`,
          "After both succeed, reply with exactly: TURN1_DONE",
        ].join(" "),
      );

      const turn1 = await waitForIdleResolvingPermissions(client, agent.id, 90_000);
      expect(turn1.status).toBe("idle");
      expect(existsSync(path.join(cwd, "cross007.txt"))).toBe(true);

      // MCP tool call is present in the timeline. The v2 model invokes MCP
      // tools through the `execute` tool, so the echo-server reference and
      // its echoed sentinel live in the tool call's input/output.
      const timeline = await client.fetchAgentTimeline(agent.id, { limit: 200 });
      const mcpEchoUsed = timeline.entries
        .map((entry) => entry.item)
        .filter((item) => item.type === "tool_call")
        .some((item) => {
          const detail = (item as { detail?: { input?: unknown; output?: unknown } }).detail;
          const input = JSON.stringify(detail?.input ?? {});
          const output = JSON.stringify(detail?.output ?? "");
          return (
            input.includes("echo-server") && input.includes("echo") && output.includes(MCP_SENTINEL)
          );
        });
      expect(mcpEchoUsed).toBe(true);

      // Turn 2: spawn a subagent on the same session.
      await client.sendMessage(
        agent.id,
        [
          "You must delegate this work using the task tool with subagent type general.",
          `Tell the child to reply with exactly: ${SUBAGENT_SENTINEL}`,
          `After the child finishes, reply with exactly: TURN2_DONE`,
        ].join(" "),
      );
      const turn2 = await waitForIdleResolvingPermissions(client, agent.id, 120_000);
      expect(turn2.status).toBe("idle");

      // The child session is discoverable and completed.
      const { subagents } = await client.listProviderSubagents(agent.id);
      expect(subagents.length).toBeGreaterThan(0);
      expect(subagents.some((subagent) => subagent.status === "completed")).toBe(true);
    } finally {
      if (agent) {
        await client.deleteAgent(agent.id).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
