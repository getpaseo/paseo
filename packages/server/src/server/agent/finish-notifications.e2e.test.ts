import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { z } from "zod";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

test.each(["create_agent", "send_agent_prompt"] as const)(
  "%s delivers the dispatcher's final follow-up exactly once after its grandchild finishes",
  async (entrypoint) => {
    const dispatcherInitial = "respond with exactly: WAITING_FOR_GRANDCHILD";
    const grandchildInitial = "respond with exactly: respond with exactly: DISPATCHER_FINAL";
    const dispatcherGate = barrier();
    const grandchildGate = barrier();
    const followupGate = barrier();
    const followupReached = barrier();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-nested-finish-"));
    const mcpClients: Client[] = [];
    const parentNotifications: string[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        // Hold real provider turns after turn_started, without permissions or sleeps.
        // This also prevents a fast fake turn from finishing before MCP arms its watcher.
        beforeAssistantResponse: async (prompt, config) => {
          // System-injected prompts are intentionally hidden from the user timeline.
          // Observe what the real daemon delivers to the parent's provider session.
          if (
            config.title === "Parent" &&
            typeof prompt === "string" &&
            prompt.startsWith("<paseo-system>")
          ) {
            parentNotifications.push(prompt);
          }
          if (prompt === dispatcherInitial) await dispatcherGate.promise;
          else if (prompt === grandchildInitial) await grandchildGate.promise;
          else if (
            typeof prompt === "string" &&
            prompt.includes("<agent-response>\nrespond with exactly: DISPATCHER_FINAL")
          ) {
            followupReached.release();
            await followupGate.promise;
          }
        },
      }),
    });
    const observer = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    async function connectMcp(callerAgentId?: string) {
      const url = new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`);
      if (callerAgentId) url.searchParams.set("callerAgentId", callerAgentId);
      const client = new Client({ name: "nested-finish-regression", version: "1.0.0" });
      mcpClients.push(client);
      await client.connect(new StreamableHTTPClientTransport(url));
      return client;
    }

    try {
      await observer.connect();
      await observer.fetchAgents({ subscribe: { subscriptionId: "nested-finish" } });
      const root = await connectMcp();
      const workspace = await callTool(root, "create_workspace", { path: cwd, isolation: "local" });
      const parent = await callTool(root, "create_agent", {
        workspaceId: z.string().parse(workspace.workspaceId),
        title: "Parent",
        provider: "claude/haiku",
        initialPrompt: "respond with exactly: READY",
        background: false,
      });
      const parentId = z.string().parse(parent.agentId);
      const parentMcp = await connectMcp(parentId);
      const dispatcher = await callTool(parentMcp, "create_agent", {
        title: "Dispatcher",
        provider: "claude/haiku",
        initialPrompt:
          entrypoint === "create_agent" ? dispatcherInitial : "respond with exactly: READY",
        notifyOnFinish: entrypoint === "create_agent",
      });
      const dispatcherId = z.string().parse(dispatcher.agentId);
      if (entrypoint === "send_agent_prompt") {
        await observer.waitForAgentUpsert(dispatcherId, (agent) => agent.status === "idle");
        await callTool(parentMcp, "send_agent_prompt", {
          agentId: dispatcherId,
          prompt: dispatcherInitial,
          background: true,
          notifyOnFinish: true,
        });
      }
      const dispatcherMcp = await connectMcp(dispatcherId);
      const grandchild = await callTool(dispatcherMcp, "create_agent", {
        title: "Grandchild",
        provider: "claude/haiku",
        initialPrompt: grandchildInitial,
        notifyOnFinish: true,
      });
      const grandchildId = z.string().parse(grandchild.agentId);
      await observer.waitForAgentUpsert(grandchildId, (agent) => agent.status === "running");

      dispatcherGate.release();
      await observer.waitForAgentUpsert(dispatcherId, (agent) => agent.status === "idle");
      expect(parentNotifications).toEqual([]);

      grandchildGate.release();
      await followupReached.promise;
      await observer.waitForAgentUpsert(grandchildId, (agent) => agent.status === "idle");
      expect(parentNotifications).toEqual([]);

      followupGate.release();
      await expect.poll(() => parentNotifications.length).toBe(1);
      const delivered = [...parentNotifications];
      const dispatcherTimeline = await observer.fetchAgentTimeline(dispatcherId, {
        limit: 100,
        projection: "canonical",
      });
      expect(
        dispatcherTimeline.entries.some(
          ({ item }) => item.type === "assistant_message" && item.text === "DISPATCHER_FINAL",
        ),
      ).toBe(true);
      expect(delivered[0]).toContain("<agent-response>\nDISPATCHER_FINAL\n</agent-response>");
      expect(delivered[0]).not.toContain("WAITING_FOR_GRANDCHILD");

      // A subsequent completed turn must not revive the consumed one-shot watcher.
      await observer.waitForAgentUpsert(dispatcherId, (agent) => agent.status === "idle");
      await callTool(root, "send_agent_prompt", {
        agentId: dispatcherId,
        prompt: "respond with exactly: LATER_DISPATCHER_TURN",
        background: false,
        notifyOnFinish: false,
      });
      expect(parentNotifications).toEqual(delivered);
    } finally {
      dispatcherGate.release();
      grandchildGate.release();
      followupGate.release();
      await Promise.all(mcpClients.map((client) => client.close()));
      await observer.close();
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);
