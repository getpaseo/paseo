#!/usr/bin/env npx tsx
/**
 * Ad-hoc script to debug checkout_status_request timeouts.
 *
 * Usage:
 *   npx tsx packages/server/src/server/daemon-e2e/checkout-debug.ts [agentId1] [agentId2]
 *
 * To test against a different daemon:
 *   PASEO_PORT=7777 npx tsx packages/server/src/server/daemon-e2e/checkout-debug.ts
 */

import { WebSocket } from "ws";
import { DaemonClientV2 } from "../../client/daemon-client-v2.js";

// Patch WebSocket to log all messages
const OriginalWebSocket = WebSocket;
class LoggingWebSocket extends OriginalWebSocket {
  constructor(url: string, ...args: any[]) {
    super(url, ...args);
    console.log(`[WS] Connecting to ${url}`);
    this.on("open", () => console.log("[WS] Connection opened"));
    this.on("close", (code, reason) => console.log(`[WS] Connection closed: ${code} ${reason}`));
    this.on("error", (err) => console.log(`[WS] Error: ${err}`));
    this.on("message", (data) => {
      const str = data.toString().slice(0, 200);
      console.log(`[WS] Message received (${data.toString().length} bytes): ${str}...`);
    });
  }
}

const PASEO_HOME = process.env.PASEO_HOME ?? "/Users/moboudra/.paseo";
const PASEO_PORT = process.env.PASEO_PORT ?? "6767";
const DAEMON_URL = `ws://127.0.0.1:${PASEO_PORT}/ws`;

async function testMultiAgentSequence() {
  console.log("\n=== Testing multi-agent checkout sequence ===");
  console.log(`Daemon URL: ${DAEMON_URL}`);

  const client = new DaemonClientV2({
    url: DAEMON_URL,
    webSocketFactory: (url) => new LoggingWebSocket(url) as any,
    reconnect: { enabled: false },
  });

  const agents: Array<{ id: string; title: string }> = [];

  // Subscribe to all events for debugging
  const unsub = client.subscribe((event) => {
    console.log(`[Event] type=${event.type}`);
    if (event.type === "agent_list") {
      console.log(`  ${event.agents.length} agents`);
      agents.length = 0;
      for (const a of event.agents) {
        agents.push({ id: a.id, title: a.title ?? "(untitled)" });
      }
    }
  });

  // Also log ALL raw messages
  client.on("agent_list", (msg: any) => {
    console.log(`[RAW agent_list] agents=${msg.agents?.length}`);
  });

  // Also log raw messages for debugging
  client.on("checkout_status_response", (msg: any) => {
    console.log(`[RAW checkout_status_response] requestId=${msg.payload.requestId} agentId=${msg.payload.agentId}`);
  });

  // Listen to connection state changes
  client.subscribeConnectionStatus((state) => {
    console.log(`[Connection] status=${state.status}`);
  });

  try {
    await client.connect();
    console.log("Connected to daemon");
    console.log(`Connection state: ${JSON.stringify(client.getConnectionState())}`);

    // Request agent list (the app does this after connecting)
    console.log("Requesting agent list...");
    client.requestAgentList();

    // Wait a bit for agent list to arrive
    console.log("Waiting 3s for agent list...");
    await new Promise((r) => setTimeout(r, 3000));

    if (agents.length === 0) {
      console.log("No agents found!");
      return;
    }

    console.log("\nAvailable agents:");
    for (const a of agents.slice(0, 10)) {
      console.log(`  - ${a.id.slice(0, 8)}... ${a.title}`);
    }
    if (agents.length > 10) {
      console.log(`  ... and ${agents.length - 10} more`);
    }

    // Pick first two agents (or use command line args)
    const agent1Id = process.argv[2] ?? agents[0]?.id;
    const agent2Id = process.argv[3] ?? agents[1]?.id ?? agents[0]?.id;

    if (!agent1Id) {
      console.log("No agents available to test");
      return;
    }

    console.log(`\n=== Test 1: Request checkout for agent1 (${agent1Id.slice(0, 8)}...) ===`);
    const start1 = Date.now();
    try {
      const status1 = await client.getCheckoutStatus(agent1Id);
      console.log(`✓ Agent1 completed in ${Date.now() - start1}ms - branch: ${status1.currentBranch}`);
    } catch (err) {
      console.log(`✗ Agent1 failed after ${Date.now() - start1}ms:`, err);
    }

    console.log(`\n=== Test 2: Request checkout for agent2 (${agent2Id.slice(0, 8)}...) ===`);
    const start2 = Date.now();
    try {
      const status2 = await client.getCheckoutStatus(agent2Id);
      console.log(`✓ Agent2 completed in ${Date.now() - start2}ms - branch: ${status2.currentBranch}`);
    } catch (err) {
      console.log(`✗ Agent2 failed after ${Date.now() - start2}ms:`, err);
    }

    console.log(`\n=== Test 3: Request checkout for agent1 again ===`);
    const start3 = Date.now();
    try {
      const status3 = await client.getCheckoutStatus(agent1Id);
      console.log(`✓ Agent1 (retry) completed in ${Date.now() - start3}ms - branch: ${status3.currentBranch}`);
    } catch (err) {
      console.log(`✗ Agent1 (retry) failed after ${Date.now() - start3}ms:`, err);
    }

    console.log(`\n=== Test 4: Request both agents in parallel ===`);
    const start4 = Date.now();
    try {
      const [p1, p2] = await Promise.all([
        client.getCheckoutStatus(agent1Id),
        client.getCheckoutStatus(agent2Id),
      ]);
      console.log(`✓ Parallel completed in ${Date.now() - start4}ms`);
      console.log(`  Agent1 branch: ${p1.currentBranch}`);
      console.log(`  Agent2 branch: ${p2.currentBranch}`);
    } catch (err) {
      console.log(`✗ Parallel failed after ${Date.now() - start4}ms:`, err);
    }

  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    unsub();
    await client.close();
  }
}

async function main() {
  console.log("Checkout Debug Script - Multi-Agent Sequence Test");
  console.log("==================================================");
  console.log(`PASEO_HOME: ${PASEO_HOME}`);

  await testMultiAgentSequence();

  console.log("\n=== Done ===");
}

main().catch(console.error);
