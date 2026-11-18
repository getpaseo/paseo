import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

let ctx: DaemonTestContext;
let cwd: string;
let emitProviderEvent: ((event: AgentStreamEvent) => Promise<void>) | null;

beforeEach(async () => {
  emitProviderEvent = null;
  ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      onSession: (session) => {
        emitProviderEvent = session.emit;
      },
    }),
  });
  cwd = mkdtempSync(path.join(tmpdir(), "running-provider-subagents-"));
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

test("an idle agent's snapshot reports the provider subagent it left running until it finishes", async () => {
  const updates: AgentSnapshotPayload[] = [];
  ctx.client.subscribeRawMessages((message) => {
    if (message.type === "agent_update" && message.payload.kind === "upsert") {
      updates.push(message.payload.agent);
    }
  });
  const agent = await ctx.client.createAgent({ provider: "codex", cwd });

  await ctx.client.sendMessage(agent.id, "Emit a provider child");
  expect((await ctx.client.waitForFinish(agent.id, 15_000)).status).toBe("idle");

  const idle = await ctx.client.fetchAgent({ agentId: agent.id });
  expect(idle?.agent).toMatchObject({ status: "idle", runningProviderSubagents: { count: 1 } });

  // The child finishes after the turn: subscribers get a snapshot without the count.
  if (!emitProviderEvent) throw new Error("The fake provider session did not start");
  await emitProviderEvent({
    type: "provider_subagent",
    provider: "codex",
    event: { type: "upsert", id: "fixture-child", status: "completed" },
  });
  await expect
    .poll(
      () => {
        const latest = updates.findLast((update) => update.id === agent.id);
        return latest ? { status: latest.status, running: latest.runningProviderSubagents } : null;
      },
      { timeout: 10_000 },
    )
    .toEqual({ status: "idle", running: undefined });
  const finished = await ctx.client.fetchAgent({ agentId: agent.id });
  expect(finished?.agent.runningProviderSubagents).toBeUndefined();
}, 60_000);
