import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import pino from "pino";
import { PluginAgentClientRegistry } from "../plugin-provider.js";
import { InMemoryAgentTimelineStore } from "../agent-timeline-store.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { buildProviderRegistry } from "../provider-registry.js";

if (!global.gc) throw new Error("Run with --expose-gc");
const logger = pino({ level: "silent" });
const plugins = new PluginAgentClientRegistry(logger);
const root = await mkdtemp(join(tmpdir(), "plugin-stream-memory-"));
const emitters: Array<(event: ProviderEvent) => void> = [];
const ids: string[] = [];
const registrations: ProviderRegistration[] = Array.from({ length: 3 }, (_, index) => ({
  id: `memory-${index}`,
  label: "Memory fixture",
  async connect() {
    let listener: (event: ProviderEvent) => void = () => {};
    const capabilities = ["prompt.message", "session.persistence"] as const;
    return {
      version: 1,
      capabilities,
      onEvent(callback) {
        listener = callback;
        // Plugin IPC delivers independent JSON strings, rather than shared ropes.
        emitters[index] = (event) => listener(JSON.parse(JSON.stringify(event)));
        return () => {
          listener = () => {};
        };
      },
      async send(input) {
        if (input.type === "session.open") {
          ids[index] = input.sessionId;
          listener({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            cwd: "/tmp",
            capabilities,
            restoration: "core",
            persistence: { version: 1, data: { index } },
          });
          listener({
            type: "session.ready",
            requestId: input.requestId,
            sessionId: input.sessionId,
          });
        } else if (input.type === "catalog") {
          listener({
            type: "catalog",
            requestId: input.requestId,
            catalog: { models: [], modes: [], thinkingOptions: [] },
          });
        } else if (input.type === "session.close") {
          listener({ type: "session.closed", sessionId: input.sessionId });
          listener({ type: "request.completed", requestId: input.requestId });
        }
      },
      async close() {},
    };
  },
}));
plugins.replace(registrations);
const store = new InMemoryAgentTimelineStore();
const manager = new AgentManager({
  clients: plugins.clients(),
  providerDefinitions: buildProviderRegistry(logger, { pluginProviders: plugins.definitions() }),
  registry: new AgentStorage(root, logger),
  timelineStore: store,
  logger,
});
const agents = await Promise.all(
  Object.keys(plugins.clients()).map((provider) =>
    manager.createAgent({ provider, cwd: root }, undefined, {}),
  ),
);
const sessions = agents.map((agent) => agent.session!);
agents.forEach((_agent, index) => {
  emitters[index]!({
    type: "session.opened",
    sessionId: `child-${index}`,
    parentSessionId: ids[index]!,
    capabilities: [],
    restoration: "parent",
    cwd: root,
  });
});
global.gc();
const before = process.memoryUsage().heapUsed;
const steps = 4;
const chunks = 200;
const expected = new Map<string, string>();
for (let step = 0; step < steps; step++) {
  for (let index = 0; index < sessions.length; index++) {
    const text = `${index}:${step}:` + "推理".repeat(15000) + "a\uD83D\uDE00b";
    expected.set(`${index}:${step}`, text);
    for (let chunk = 1; chunk <= chunks; chunk++) {
      for (const sessionId of [ids[index]!, `child-${index}`]) {
        emitters[index]!({
          type: "timeline.item",
          sessionId,
          item: {
            type: "reasoning",
            id: `reason-${step}`,
            text: text.slice(0, Math.ceil((chunk * text.length) / chunks)),
          },
        });
      }
    }
    emitters[index]!({
      type: "timeline.item",
      sessionId: ids[index]!,
      item: {
        type: "tool_call",
        id: `tool-${step}`,
        callId: `tool-${step}`,
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: null, output: "输出".repeat(16000) },
      },
    });
    emitters[index]!({
      type: "timeline.item",
      sessionId: `child-${index}`,
      item: {
        type: "assistant_message",
        id: `answer-${step}`,
        text: "Child step complete.",
      },
    });
  }
  // Drain the manager's event queue; terminal tool states flush its real coalescer.
  await delay(80);
}
global.gc();
const retained = process.memoryUsage().heapUsed - before;
assert(retained < 24 * 1024 * 1024, `Retained heap exceeded 24 MiB: ${retained} bytes`);
for (let index = 0; index < sessions.length; index++) {
  const items = store.getItems(agents[index]!.id);
  assert.equal(items.length, steps * 2);
  for (let step = 0; step < steps; step++) {
    const item = items[step * 2]!;
    assert.equal(item.type === "reasoning" && item.text, expected.get(`${index}:${step}`));
  }
  const children = manager.listProviderSubagents(agents[index]!.id);
  assert.equal(children.length, 1);
  let rootItems = 0;
  let childItems = 0;
  for await (const event of sessions[index]!.streamHistory()) {
    if (event.type === "timeline") rootItems++;
    if (event.type === "provider_subagent" && event.event.type === "timeline") childItems++;
  }
  assert.equal(rootItems, steps * 2);
  assert.equal(childItems, steps * 2);
  await manager.archiveAgent(agents[index]!.id);
  assert.equal(store.has(agents[index]!.id), false);
  assert.equal(
    manager.listAgents().some((agent) => agent.id === agents[index]!.id),
    false,
  );
}
await plugins.shutdown();
await manager.flushForShutdown();
await rm(root, { recursive: true, force: true });
global.gc();
const closed = process.memoryUsage().heapUsed - before;
// Keep closed session references alive, as callers can retain them after archive.
assert.equal(sessions.length, 3);
process.stdout.write(JSON.stringify({ retained, closed }));
