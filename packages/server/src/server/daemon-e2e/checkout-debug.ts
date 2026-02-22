#!/usr/bin/env npx tsx
/**
 * Ad-hoc script to debug checkout_status_request timeouts.
 *
 * Usage:
 *   npx tsx packages/server/src/server/daemon-e2e/checkout-debug.ts [agentIdOrCwd1] [agentIdOrCwd2]
 *
 * To test against a different daemon:
 *   PASEO_LISTEN=127.0.0.1:7777 npx tsx packages/server/src/server/daemon-e2e/checkout-debug.ts
 */

import { WebSocket } from "ws";
import os from "node:os";
import { DaemonClient } from "../../client/daemon-client.js";

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

const PASEO_HOME = process.env.PASEO_HOME ?? `${os.homedir()}/.paseo`;
const PASEO_LISTEN = process.env.PASEO_LISTEN ?? "127.0.0.1:6767";
const DAEMON_URL = `ws://${PASEO_LISTEN}/ws`;
const CLIENT_ID = "clsk_checkout_debug";

async function testMultiAgentSequence() {
  console.log("\n=== Testing multi-agent checkout sequence ===");
  console.log(`Daemon URL: ${DAEMON_URL}`);

  const client = new DaemonClient({
    url: DAEMON_URL,
    clientId: CLIENT_ID,
    webSocketFactory: (url) => new LoggingWebSocket(url) as any,
    reconnect: { enabled: false },
  });

  const agents: Array<{ id: string; title: string; cwd: string }> = [];

  // Also log raw messages for debugging
  client.on("checkout_status_response", (msg: any) => {
    console.log(
      `[RAW checkout_status_response] requestId=${msg.payload.requestId} cwd=${msg.payload.cwd}`
    );
  });

  // Listen to connection state changes
  client.subscribeConnectionStatus((state) => {
    console.log(`[Connection] status=${state.status}`);
  });

  try {
    await client.connect();
    console.log("Connected to daemon");
    console.log(`Connection state: ${JSON.stringify(client.getConnectionState())}`);

    console.log("Fetching agents...");
    const agentsList = await client.fetchAgents();
    agents.length = 0;
    for (const a of agentsList) {
      agents.push({ id: a.id, title: a.title ?? "(untitled)", cwd: a.cwd });
    }

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
    const arg1 = process.argv[2];
    const arg2 = process.argv[3];
    const agent1 = (arg1 ? agents.find((a) => a.id === arg1) : null) ?? agents[0] ?? null;
    const agent2 =
      (arg2 ? agents.find((a) => a.id === arg2) : null) ??
      agents[1] ??
      agents[0] ??
      null;

    const cwd1 = arg1 && !agent1 ? arg1 : agent1?.cwd;
    const cwd2 = arg2 && !agent2 ? arg2 : agent2?.cwd;

    if (!cwd1) {
      console.log("No checkout cwd available to test");
      return;
    }

    console.log(`\n=== Test 1: Request checkout for cwd1 (${cwd1}) ===`);
    const start1 = Date.now();
    try {
      const status1 = await client.getCheckoutStatus(cwd1);
      console.log(
        `✓ Cwd1 completed in ${Date.now() - start1}ms - branch: ${status1.currentBranch}`
      );
    } catch (err) {
      console.log(`✗ Cwd1 failed after ${Date.now() - start1}ms:`, err);
    }

    if (cwd2) {
      console.log(`\n=== Test 2: Request checkout for cwd2 (${cwd2}) ===`);
      const start2 = Date.now();
      try {
        const status2 = await client.getCheckoutStatus(cwd2);
        console.log(
          `✓ Cwd2 completed in ${Date.now() - start2}ms - branch: ${status2.currentBranch}`
        );
      } catch (err) {
        console.log(`✗ Cwd2 failed after ${Date.now() - start2}ms:`, err);
      }
    }

    console.log(`\n=== Test 3: Request checkout for cwd1 again ===`);
    const start3 = Date.now();
    try {
      const status3 = await client.getCheckoutStatus(cwd1);
      console.log(
        `✓ Cwd1 (retry) completed in ${Date.now() - start3}ms - branch: ${status3.currentBranch}`
      );
    } catch (err) {
      console.log(`✗ Cwd1 (retry) failed after ${Date.now() - start3}ms:`, err);
    }

    if (cwd2) {
      console.log(`\n=== Test 4: Request both cwds in parallel ===`);
      const start4 = Date.now();
      try {
        const [p1, p2] = await Promise.all([
          client.getCheckoutStatus(cwd1),
          client.getCheckoutStatus(cwd2),
        ]);
        console.log(`✓ Parallel completed in ${Date.now() - start4}ms`);
        console.log(`  Cwd1 branch: ${p1.currentBranch}`);
        console.log(`  Cwd2 branch: ${p2.currentBranch}`);
      } catch (err) {
        console.log(`✗ Parallel failed after ${Date.now() - start4}ms:`, err);
      }
    }

  } catch (error) {
    console.error("Test failed:", error);
  } finally {
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
