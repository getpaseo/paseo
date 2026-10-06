import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import pino from "pino";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { CodexAppServerAgentSession } from "./providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./providers/codex/test-utils/fake-app-server.js";
import type { AgentClient } from "./agent-sdk-types.js";

test("projects Codex child history and confines old-client degradation to the child transcript", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-projected-contract-"));
  const app = createFakeCodexAppServer();
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd },
    null,
    pino({ level: "silent" }),
    async () => app.child,
  );
  await session.connect();
  const provider: AgentClient = {
    provider: "codex",
    capabilities: session.capabilities,
    isAvailable: async () => true,
    createSession: async () => session,
    resumeSession: async () => session,
    fetchCatalog: async () => ({ models: [], modes: [] }),
  };
  const ctx = await createDaemonTestContext({
    pluginsEnabled: false,
    relayEnabled: false,
    agentClients: { codex: provider },
  });
  const legacy = new DaemonClient({
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    capabilities: { [CLIENT_CAPS.projectedSubagentTimeline]: false },
  });
  await legacy.connect();
  const messages = createMessageCollector(legacy);
  const observation = legacy.observeEvents(["agent.provider_subagents.update"]);
  const unsubscribe = observation.subscribe({ snapshot() {}, update() {} });
  await observation.ready;
  try {
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Projected contract",
    });
    app.startsTurn({ threadId: "thread-1" });
    app.startsSubAgent({ callId: "spawn-child", threadId: "child-thread", agentPath: "child" });
    for (const delta of ["A", "B", "C"]) {
      app.child.stdout.write(
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { threadId: "child-thread", itemId: "message-1", delta },
        }) + "\n",
      );
    }
    await expect
      .poll(() => ctx.daemon.daemon.agentManager.listProviderSubagents(agent.id).length)
      .toBe(1);
    await expect
      .poll(
        () =>
          ctx.daemon.daemon.agentManager.fetchProviderSubagentTimeline(agent.id, "child-thread")
            .window.maxSeq,
      )
      .toBe(3);
    const child = await ctx.client.fetchProviderSubagentTimeline(agent.id, "child-thread", {
      limit: 1,
    });
    expect(child.projection).toBe("projected");
    expect(child.rows).toMatchObject([{ seqStart: 1, seqEnd: 3, item: { text: "ABC" } }]);
    const catchUp = await ctx.client.fetchProviderSubagentTimeline(agent.id, "child-thread", {
      direction: "after",
      cursor: { epoch: child.epoch, seq: 1 },
    });
    expect(catchUp.rows).toMatchObject([{ item: { text: "ABC" } }]);
    const oldChild = await legacy.fetchProviderSubagentTimeline(agent.id, "child-thread");
    expect(oldChild.rows).toMatchObject([
      { item: { type: "assistant_message", text: expect.stringContaining("upgrade") } },
    ]);
    expect((await legacy.listProviderSubagents(agent.id)).subagents).toHaveLength(1);
    expect(
      messages.messages.some(
        (message) =>
          message.type === "agent.provider_subagents.update" && message.payload.kind === "upsert",
      ),
    ).toBe(true);
    expect(
      messages.messages.some(
        (message) =>
          message.type === "agent.provider_subagents.update" && message.payload.kind === "timeline",
      ),
    ).toBe(false);
    const root = await legacy.fetchAgentTimeline(agent.id, { projection: "canonical", limit: 0 });
    expect(root.error).toBeNull();
    expect(root.projection).toBe("projected");
    expect(root.entries).toHaveLength(1);
    expect((await legacy.buildAgentForkContext(agent.id)).attachment.text).toContain(
      "[Child] child",
    );
    app.assertNoErrors();
  } finally {
    unsubscribe();
    messages.unsubscribe();
    await legacy.close();
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("resuming Codex restores child descriptors and complete messages without historical deltas", async () => {
  const app = createFakeCodexAppServer({
    "thread/read": (params) => {
      const { threadId } = params as { threadId: string };
      return {
        thread: {
          id: threadId,
          turns: [
            {
              id: "turn",
              items:
                threadId === "root"
                  ? [
                      {
                        type: "subAgentActivity",
                        id: "spawn",
                        kind: "started",
                        agentThreadId: "child",
                        agentPath: "explore",
                      },
                    ]
                  : [{ type: "agentMessage", id: "message", text: "Complete child answer" }],
            },
          ],
        },
      };
    },
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: tmpdir() },
    { sessionId: "root" },
    pino({ level: "silent" }),
    async () => app.child,
  );
  try {
    await session.connect();
    const children = [];
    for await (const event of session.streamHistory()) {
      if (event.type === "provider_subagent") children.push(event.event);
    }
    expect(children).toMatchObject([
      { type: "upsert", id: "child", status: "completed" },
      {
        type: "timeline",
        id: "child",
        item: { type: "assistant_message", text: "Complete child answer" },
      },
    ]);
    app.assertNoErrors();
  } finally {
    await session.close();
  }
});

test("retains only the latest cumulative Pi tool progress payload", async () => {
  const { parseToolArgs, parseToolResult, mapToolDetail } =
    await import("./providers/pi/tool-call-mapper.js");
  const { InMemoryAgentTimelineStore } = await import("./agent-timeline-store.js");
  const store = new InMemoryAgentTimelineStore();
  store.initialize("agent");
  const tool = parseToolArgs("custom_progress", {});
  const messages: string[] = [];
  for (let index = 0; index < 20; index++) {
    messages.push(`Update ${index}: ${"x".repeat(2048)}`);
    const result = parseToolResult({
      content: [{ type: "text", text: "running" }],
      details: { results: [{ messages: [...messages] }] },
    });
    store.append("agent", {
      type: "tool_call",
      callId: "same-call",
      name: "custom_progress",
      status: "running",
      error: null,
      detail: mapToolDetail(tool, result),
    });
  }
  const history = store.fetch("agent", { limit: 0 });
  expect(history.rows).toHaveLength(1);
  expect(history.rows[0]).toMatchObject({
    seqStart: 1,
    seqEnd: 20,
    item: { detail: { output: { details: { results: [{ messages }] } } } },
  });
  expect(JSON.stringify(history.rows).length).toBeLessThan(50_000);
});
