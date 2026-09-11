import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { expect, test } from "vitest";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import { AgentManager, type AgentManagerEvent } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";

async function setup() {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-plugin-subagents-"));
  const logger = pino({ level: "silent" });
  const registry = new AgentStorage(path.join(cwd, "agents"), logger);
  const manager = new AgentManager({
    clients: { pi: createTestAgentClient("pi") },
    registry,
    logger,
  });
  const parent = await manager.createAgent({ provider: "pi", cwd }, undefined, {
    workspaceId: undefined,
  });
  return {
    manager,
    parent,
    cwd,
    async close() {
      await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
      await registry.flush();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("plugin reports keep a Pi parent literal and survive native history refresh", async () => {
  const fixture = await setup();
  const { manager, parent } = fixture;
  try {
    const reporter = manager.openPluginSubagentReporter("external", parent.id);
    const events: AgentManagerEvent[] = [];
    const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
    const status = manager.getAgent(parent.id)?.lifecycle;
    await reporter.report({ type: "upsert", id: "child", status: "running" });
    await reporter.report({
      type: "timeline",
      id: "child",
      item: { type: "assistant_message", text: "Independent child" },
    });
    const descriptor = manager.listProviderSubagents(parent.id)[0]!;
    await manager.hydrateTimelineFromProvider(parent.id, { force: true, broadcast: true });
    expect(manager.listProviderSubagents(parent.id)).toEqual([descriptor]);
    expect(manager.fetchProviderSubagentTimeline(parent.id, descriptor.id).rows[0]?.item).toEqual({
      type: "assistant_message",
      text: "Independent child",
    });
    expect(manager.listProviderSubagentActivity()).toEqual([descriptor]);
    expect(manager.getAgent(parent.id)?.lifecycle).toBe(status);
    expect(manager.listAgents()).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "provider_subagent").map((event) => event.event.type),
    ).toEqual(["upsert", "timeline"]);
    unsubscribe();
  } finally {
    await fixture.close();
  }
});

test.each([
  ["close", "closeAgent"],
  ["reload", "reloadAgentSession"],
  ["archive", "archiveAgent"],
] as const)(
  "parent %s removes plugin rows and rejects its old reporter",
  async (_action, method) => {
    const fixture = await setup();
    const { manager, parent } = fixture;
    try {
      const reporter = manager.openPluginSubagentReporter("external", parent.id);
      await reporter.report({ type: "upsert", id: "child", status: "running" });
      const events: AgentManagerEvent[] = [];
      const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
      await manager[method](parent.id);
      await reporter.close();
      await reporter.close();
      await expect(reporter.report({ type: "upsert", id: "child" })).rejects.toThrow("closed");
      expect(
        events
          .filter((event) => event.type === "provider_subagent")
          .map((event) => event.event.type),
      ).toEqual(["remove"]);
      expect(manager.listProviderSubagentActivity()).toEqual([]);
      unsubscribe();
    } finally {
      await fixture.close();
    }
  },
);

test("reporter opening does not resume unknown or closed parents, or expose internal agents", async () => {
  const fixture = await setup();
  const { manager, parent, cwd } = fixture;
  try {
    expect(() => manager.openPluginSubagentReporter("external", randomUUID())).toThrow(
      "Unknown agent",
    );
    const internal = await manager.createAgent({ provider: "pi", cwd, internal: true }, undefined, {
      workspaceId: undefined,
    });
    expect(() => manager.openPluginSubagentReporter("external", internal.id)).toThrow(
      "Unknown agent",
    );
    await manager.closeAgent(parent.id);
    expect(() => manager.openPluginSubagentReporter("external", parent.id)).toThrow(
      "Unknown agent",
    );
  } finally {
    await fixture.close();
  }
});
