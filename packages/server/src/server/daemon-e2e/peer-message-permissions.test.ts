import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { FormInfo } from "@opencode/client";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { OpenCodeV2AgentClient } from "../agent/providers/opencode/v2/agent.js";
import { V2Harness } from "../agent/providers/opencode/test-utils/v2-harness.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

async function createQuestionHarness() {
  const artifacts = path.resolve(".artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "peer-permissions-"));
  const runtime = new V2Harness();
  runtime.autoComplete = false;
  runtime.api.model.list = async () => ({ location: runtime.info.location, data: [] });
  runtime.api.provider.list = async () => ({
    location: runtime.info.location,
    data: [{ id: "test", name: "Test", activation: "enabled", package: "test" }],
  });
  let form: FormInfo | null = null;
  const answers: Array<Record<string, unknown>> = [];
  runtime.api.session.form.list = async () => (form ? [form] : []);
  runtime.api.session.form.cancel = async () => {
    form = null;
    runtime.finishExecution("interrupted");
  };
  runtime.api.session.form.reply = async ({ answer }) => {
    answers.push(answer);
    form = null;
    runtime.finishExecution();
  };
  // A steer is admitted to the existing execution, rather than starting another one.
  runtime.prompt = async (input) => {
    runtime.prompts.push(input.text);
    if (runtime.prompts.length === 1) runtime.startExecution();
  };
  const provider = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: runtime.runtime,
  });
  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), opencode: provider },
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const recipient = await client.createAgent({
      provider: "opencode",
      cwd: root,
      title: "Waiting for a human answer",
    });
    const sender = await client.createAgent({ provider: "claude", cwd: root });
    await client.sendMessage(recipient.id, "Ask which color to use");
    await expect.poll(() => runtime.prompts).toHaveLength(1);
    form = {
      id: "color-question",
      sessionID: "session",
      title: "Color",
      fields: [{ key: "color", title: "Color", type: "string" }],
    };
    runtime.push({ id: "question-created", created: 2, type: "form.created", data: { form } });
    await client.waitForAgentUpsert(recipient.id, (agent) =>
      (agent.pendingPermissions ?? []).some((request) => request.id === "color-question"),
    );
    return {
      client,
      recipient,
      sender,
      answers,
      async close() {
        await client.close();
        await daemon.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("an agent-sourced steer leaves the question pending and answerable", async () => {
  const { client, recipient, sender, answers, close } = await createQuestionHarness();
  try {
    await client.sendAgentMessage(recipient.id, "Peer status check", {
      sourceAgentId: sender.id,
    });
    // The public wait includes admitted message delivery before reporting permission status.
    const waiting = await client.waitForFinish(recipient.id);
    expect(waiting.status).toBe("permission");
    expect(waiting.final?.pendingPermissions).toMatchObject([
      { id: "color-question", kind: "question" },
    ]);
    await client.respondToPermission(recipient.id, "color-question", {
      behavior: "allow",
      updatedInput: { answers: { Color: "Blue" } },
    });
    await client.waitForAgentUpsert(
      recipient.id,
      (agent) => (agent.pendingPermissions ?? []).length === 0 && agent.status === "idle",
    );
    expect(answers).toEqual([{ color: "Blue" }]);
  } finally {
    await close();
  }
});

test("a human steer still dismisses the question", async () => {
  const { client, recipient, answers, close } = await createQuestionHarness();
  try {
    await client.sendAgentMessage(recipient.id, "Use red instead", { activeTurnBehavior: "steer" });
    const finished = await client.waitForFinish(recipient.id);
    expect(finished.status).toBe("idle");
    expect(finished.final?.pendingPermissions ?? []).toEqual([]);
    expect(answers).toEqual([]);
  } finally {
    await close();
  }
});
