import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDaemonTestContext,
  DaemonClient,
  type DaemonTestContext,
} from "../test-utils/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { AgentMcpServer } from "./agent-sdk-types.js";

const REPORTED_SERVERS: AgentMcpServer[] = [
  { name: "paseo", status: "connected", toolCount: 12 },
  { name: "stripe", status: "needs_auth", scope: "claudeai" },
  { name: "salt-brain", status: "failed", error: "spawn ENOENT" },
];

let ctx: DaemonTestContext;
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "mcp-status-e2e-"));
});

afterEach(async () => {
  await ctx?.cleanup();
  rmSync(cwd, { recursive: true, force: true });
});

test("agent.mcp.list round-trips the provider's report to the client", async () => {
  ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({ mcpServerStatus: REPORTED_SERVERS }),
  });
  const agent = await ctx.client.createAgent({ provider: "codex", cwd });

  const payload = await ctx.client.listMcpServers(agent.id);

  expect(payload.agentId).toBe(agent.id);
  expect(payload.error).toBeNull();
  expect(payload.unavailable).toBeUndefined();
  expect(payload.source).toBe("live");
  expect(payload.servers).toEqual(REPORTED_SERVERS);
  expect(Date.parse(payload.fetchedAt)).not.toBeNaN();
});

test("the snapshot advertises the capability the panel gates on", async () => {
  ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({ mcpServerStatus: REPORTED_SERVERS }),
  });
  const agent = await ctx.client.createAgent({ provider: "codex", cwd });

  expect(agent.capabilities.supportsMcpStatus).toBe(true);
});

test("a provider with no MCP source is reported unsupported, not as an error", async () => {
  ctx = await createDaemonTestContext();
  const agent = await ctx.client.createAgent({ provider: "codex", cwd });

  expect(agent.capabilities.supportsMcpStatus).toBeUndefined();

  const payload = await ctx.client.listMcpServers(agent.id);
  expect(payload.unavailable).toBe("unsupported");
  expect(payload.servers).toEqual([]);
  // Not an error: there is nothing wrong, so the app hides the control rather than
  // rendering a panel whose only content explains why it is empty.
  expect(payload.error).toBeNull();
});

test("an unknown agent id is reported as an error rather than an empty list", async () => {
  ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({ mcpServerStatus: REPORTED_SERVERS }),
  });

  const payload = await ctx.client.listMcpServers("agent-that-does-not-exist");
  expect(payload.servers).toEqual([]);
  expect(payload.error).toContain("Agent not found");
  // A missing agent is an error, not a verdict about the provider — the control stays
  // put so a reload can recover it.
  expect(payload.unavailable).toBeUndefined();
});

test("two separate clients share one provider call", async () => {
  let calls = 0;
  ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      mcpServerStatus: REPORTED_SERVERS,
      onListMcpServers: () => {
        calls += 1;
      },
    }),
  });
  const agent = await ctx.client.createAgent({ provider: "codex", cwd });

  // A second socket, which the daemon gives its own Session. Reusing `ctx.client` here
  // would only prove one session dedupes against itself, which a per-session cache did
  // too — the point of hoisting the cache is that a second device does not pay again.
  const second = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  await second.connect();
  try {
    const [a, b] = await Promise.all([
      ctx.client.listMcpServers(agent.id, { requestId: "a" }),
      second.listMcpServers(agent.id, { requestId: "b" }),
    ]);

    expect(a.servers).toEqual(REPORTED_SERVERS);
    expect(b.servers).toEqual(REPORTED_SERVERS);
    // Codex answers this in ~3.5s and 1.1MB; two open panels must not cost two of those.
    expect(calls).toBe(1);
    // And a cache hit keeps the original fetch time rather than claiming it is current.
    expect(new Date(b.fetchedAt).getTime()).toBeLessThanOrEqual(Date.now());
  } finally {
    await second.close();
  }
});

test("a new runtime for the same agent invalidates the cached report", async () => {
  let calls = 0;
  ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      mcpServerStatus: REPORTED_SERVERS,
      onListMcpServers: () => {
        calls += 1;
      },
    }),
  });
  const agent = await ctx.client.createAgent({ provider: "codex", cwd });

  await ctx.client.listMcpServers(agent.id);
  expect(calls).toBe(1);

  // Restarting the agent can change which servers it has, so the cache must not answer
  // for the runtime it outlived.
  const restarted = await ctx.client.createAgent({ provider: "codex", cwd });
  await ctx.client.listMcpServers(restarted.id);
  expect(calls).toBe(2);
});

test("refresh forces past the cache", async () => {
  let calls = 0;
  ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      mcpServerStatus: REPORTED_SERVERS,
      onListMcpServers: () => {
        calls += 1;
      },
    }),
  });
  const agent = await ctx.client.createAgent({ provider: "codex", cwd });

  await ctx.client.listMcpServers(agent.id);
  await ctx.client.listMcpServers(agent.id);
  expect(calls).toBe(1);

  await ctx.client.listMcpServers(agent.id, { force: true });
  expect(calls).toBe(2);
});
