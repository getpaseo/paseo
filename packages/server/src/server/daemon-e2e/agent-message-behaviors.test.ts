import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../agent/providers/opencode/bridge.js";
import { OpenCodeV2AgentClient } from "../agent/providers/opencode/v2/agent.js";
import { V2Harness } from "../agent/providers/opencode/test-utils/v2-harness.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

/** A recipient whose first turn keeps running until the test ends it. Its provider can steer. */
async function createWorkingRecipient(options: { olderClient?: boolean } = {}) {
  const artifacts = path.resolve(".artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "agent-message-behaviors-"));
  const runtime = new V2Harness();
  runtime.autoComplete = false;
  runtime.api.model.list = async () => ({ location: runtime.info.location, data: [] });
  runtime.api.provider.list = async () => ({
    location: runtime.info.location,
    data: [{ id: "test", name: "Test", activation: "enabled", package: "test" }],
  });
  // A steer is admitted to the running execution, rather than starting another one.
  runtime.prompt = async (input) => {
    runtime.prompts.push(input.text);
    if (runtime.prompts.length === 1) runtime.startExecution();
  };
  // The daemon always runs the bridge, which gives OpenCode agents their Paseo tools.
  const bridge = new OpenCodeBridge({
    paseoHome: path.join(root, "bridge"),
    logger: createTestLogger(),
  });
  await bridge.start();
  const daemon = await createTestPaseoDaemon({
    agentClients: {
      ...createTestAgentClients(),
      opencode: new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: runtime.runtime,
        bridge,
      }),
    },
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    // An older CLI or connected host does not advertise the capability.
    ...(options.olderClient
      ? { capabilities: { [CLIENT_CAPS.agentActiveTurnBehaviors]: false } }
      : {}),
  });
  const close = async () => {
    await client.close();
    await daemon.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  };
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const recipient = await client.createAgent({
      provider: "opencode",
      cwd: root,
      title: "Worker",
    });
    const sender = await client.createAgent({ provider: "claude", cwd: root });
    await client.sendMessage(recipient.id, "Long work");
    await client.waitForAgentUpsert(recipient.id, (agent) => agent.status === "running");
    return { client, runtime, recipient, sender, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test("an agent's message without a behavior waits for the running turn and says how to deliver it now", async () => {
  const { client, runtime, recipient, sender, close } = await createWorkingRecipient();
  try {
    const receipt = await client.sendAgentMessage(recipient.id, "Report when done", {
      sourceAgentId: sender.id,
    });
    expect(receipt).toMatchObject({ deliveryStatus: "queued", activeTurnBehavior: "queue" });
    expect(receipt.guidance).toContain("Queued, not delivered yet.");
    expect(receipt.guidance).toContain('"steer" (it joins the running turn)');
    expect(runtime.prompts).toHaveLength(1);

    runtime.finishExecution();
    await expect.poll(() => runtime.prompts.length, { timeout: 10_000 }).toBe(2);
    expect(runtime.prompts[1]).toContain("Report when done");
  } finally {
    await close();
  }
});

test("an agent's steer joins the running turn at once", async () => {
  const { client, runtime, recipient, sender, close } = await createWorkingRecipient();
  try {
    const receipt = await client.sendAgentMessage(recipient.id, "Use the other API", {
      sourceAgentId: sender.id,
      activeTurnBehavior: "steer",
    });
    expect(receipt).toMatchObject({ deliveryStatus: "queued", activeTurnBehavior: "steer" });
    expect(receipt.guidance).toBe(
      "Steering the running turn. The agent reads your message at its next step and keeps working.",
    );
    await expect.poll(() => runtime.prompts.length).toBe(2);
    expect(runtime.prompts[1]).toContain("Use the other API");
  } finally {
    await close();
  }
});

test("an older client's agent steer still waits for the running turn to end", async () => {
  const { client, runtime, recipient, sender, close } = await createWorkingRecipient({
    olderClient: true,
  });
  try {
    // Older CLIs and connected hosts send steer for every default agent send.
    const receipt = await client.sendAgentMessage(recipient.id, "Report when done", {
      sourceAgentId: sender.id,
      activeTurnBehavior: "steer",
    });
    expect(receipt).toMatchObject({ deliveryStatus: "queued", activeTurnBehavior: "queue" });
    expect(runtime.prompts).toHaveLength(1);
    runtime.finishExecution();
    await expect.poll(() => runtime.prompts.length, { timeout: 10_000 }).toBe(2);
  } finally {
    await close();
  }
});

test("a non-agent queued prompt waits behind a running turn without interrupting and delivers as a raw user prompt", async () => {
  const { client, runtime, recipient, close } = await createWorkingRecipient();
  try {
    let aborts = 0;
    const originalAbort = runtime.api.session.abort;
    runtime.api.session.abort = async (input) => {
      aborts += 1;
      return originalAbort(input);
    };

    const receipt = await client.sendAgentMessage(recipient.id, "Decision approved", {
      activeTurnBehavior: "queue",
    });
    expect(receipt).toMatchObject({ deliveryStatus: "queued", activeTurnBehavior: "queue" });
    expect(receipt.guidance).toContain("Queued, not delivered yet.");
    expect(runtime.active).toBe(true);
    expect(aborts).toBe(0);
    expect(runtime.prompts).toEqual(["Long work"]);

    runtime.finishExecution();
    await expect.poll(() => runtime.prompts.length, { timeout: 10_000 }).toBe(2);
    expect(aborts).toBe(0);
    expect(runtime.prompts[1]).toBe("Decision approved");
  } finally {
    await close();
  }
});

test("paseo.agents.ref().send with activeTurnBehavior queue works while running and starts immediately when idle", async () => {
  const { client, runtime, recipient, close } = await createWorkingRecipient();
  try {
    const paseo = createPaseoApi(client);
    // Start execution for every prompt so each turn stays active until finishExecution().
    runtime.prompt = async (input) => {
      runtime.prompts.push(input.text);
      if (!runtime.active) runtime.startExecution();
    };

    await paseo.agents.ref(recipient.id).send("Answer from Inbox", {
      activeTurnBehavior: "queue",
    });
    expect(runtime.active).toBe(true);
    expect(runtime.prompts).toEqual(["Long work"]);

    runtime.finishExecution();
    await expect.poll(() => runtime.prompts.length, { timeout: 10_000 }).toBe(2);
    expect(runtime.prompts[1]).toBe("Answer from Inbox");

    // Finish turn 2 so the recipient returns to idle, then queue another non-agent prompt.
    runtime.finishExecution();
    await client.waitForAgentUpsert(recipient.id, (agent) => agent.status === "idle");

    const startedAt = Date.now();
    const idleReceipt = await client.sendAgentMessage(recipient.id, "Immediate while idle", {
      activeTurnBehavior: "queue",
    });
    expect(idleReceipt).toMatchObject({
      deliveryStatus: "queued",
      activeTurnBehavior: "queue",
      guidance: "The agent is idle, so your message starts a turn now.",
    });
    await expect.poll(() => runtime.prompts.length, { timeout: 1_500 }).toBe(3);
    // Starts immediately rather than waiting for the 2-second agent batching quiet window.
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(runtime.prompts[2]).toBe("Immediate while idle");
  } finally {
    await close();
  }
});
